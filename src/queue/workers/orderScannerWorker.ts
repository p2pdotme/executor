import { Worker } from 'bullmq';
import { CommonConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import {
    ORDER_SCANNER_QUEUE_NAME,
    initOrderScannerQueue,
    connection,
} from '../index';
import { syncOrderIds } from '../../utils/orderTracker';

// BullMQ renews lock every lockDuration/2 while the job is running.
// Truly stuck jobs get reclaimed after 3 min.
const LOCK_DURATION_MS = 180_000; // 3 min
const JOB_TIMEOUT_MS = 150_000;   // 2.5 min: hard deadline so worker never stalls indefinitely

export function startOrderScannerWorker(config: CommonConfig) {
    initOrderScannerQueue();

    const worker = new Worker(
        ORDER_SCANNER_QUEUE_NAME,
        async (_job) => {
            const timeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('job timeout after ' + JOB_TIMEOUT_MS + 'ms')), JOB_TIMEOUT_MS),
            );

            await Promise.race([
                (async () => {
                    logger.info('order-scanner: starting sync tick');

                    try {
                        // sync last 2500 blocks
                        await syncOrderIds(config, 2500);

                        logger.info('order-scanner: sync tick completed');
                    } catch (err: any) {
                        const msg = 'order-scanner: sync tick failed: ' + String(err?.message ?? err);
                        logger.error(msg);
                        throw err;
                    }
                })(),
                timeout,
            ]);
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
