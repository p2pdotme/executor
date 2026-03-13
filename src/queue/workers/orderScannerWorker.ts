import { Worker } from 'bullmq';
import { CommonConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import {
    ORDER_SCANNER_QUEUE_NAME,
    initOrderScannerQueue,
    connection,
} from '../index';
import { syncOrderIds } from '../../utils/orderTracker';
import { withTimeout } from '../../helpers/provider';

// BullMQ renews lock every lockDuration/2 while the job is running.
// Truly stuck jobs get reclaimed after 3 min.
const LOCK_DURATION_MS = 180_000; // 3 min
const JOB_TIMEOUT_MS = 150_000;   // 2.5 min: hard deadline so worker never stalls indefinitely

export function startOrderScannerWorker(config: CommonConfig) {
    initOrderScannerQueue();

    const worker = new Worker(
        ORDER_SCANNER_QUEUE_NAME,
        async (_job) => {
            logger.info('order-scanner: starting sync tick');

            try {
                await withTimeout(syncOrderIds(config, 2500), JOB_TIMEOUT_MS);
                logger.info('order-scanner: sync tick completed');
            } catch (err: any) {
                const msg = 'order-scanner: sync tick failed: ' + String(err?.message ?? err);
                logger.error(msg);
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
        logger.error('order-scanner: worker error: ' + err?.message),
    );

    worker.on('completed', (job) =>
        logger.info('order-scanner: completed jobId=' + job.id + ' ' + job.name),
    );

    worker.on('failed', (job, err) =>
        logger.warn('order-scanner: failed jobId=' + job?.id + ' ' + job?.name + ': ' + err?.message),
    );

    logger.info('order-scanner: started');
}
