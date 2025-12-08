import { Worker } from 'bullmq';
import { CommonConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import {
    ORDER_SCANNER_QUEUE_NAME,
    initOrderScannerQueue,
    connection,
} from '../index';
import { syncOrderIds } from '../../utils/orderTracker';

const LOCK_DURATION_MS = 60_000; // 60s is more than enough for a scan

export function startOrderScannerWorker(config: CommonConfig) {
    initOrderScannerQueue();

    const worker = new Worker(
        ORDER_SCANNER_QUEUE_NAME,
        async (_job) => {
            logger.info('🔍 order-scanner: starting sync tick');

            try {
                // sync last 2500 blocks
                await syncOrderIds(config, 2500);

                logger.info('✅ order-scanner: sync tick completed');
            } catch (err: any) {
                const msg = `❌ order-scanner: sync tick failed: ${String(
                    err?.message ?? err,
                )}`;
                logger.error(msg);
                // no sendOnFail needed if you don’t want alerts here;
                // if you do, just import and call sendOnFail(config, msg)
                throw err;
            }
        },
        {
            connection,
            concurrency: 1,
            lockDuration: LOCK_DURATION_MS,
        },
    );

    worker.on('error', (err) =>
        logger.error(`❌ order-scanner: worker error: ${err?.message}`),
    );

    worker.on('completed', (job) =>
        logger.info(`✅ order-scanner: completed jobId=${job.id} ${job.name}`),
    );

    worker.on('failed', (job, err) =>
        logger.warn(
            `❌ order-scanner: failed jobId=${job?.id} ${job?.name}: ${err?.message}`,
        ),
    );

    logger.info('🔍 order-scanner: started');
}
