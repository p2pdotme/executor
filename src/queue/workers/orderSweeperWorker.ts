import { Worker } from 'bullmq';
import { Contract } from 'ethers';
import { OrderSweeperConfig } from '../../helpers/config';
import { getOrderSweeperSigner } from '../../helpers/provider';
import { logger } from '../../helpers/logger';
import {
    ORDER_SWEEPER_QUEUE_NAME,
    initOrderSweeperQueue,
    connection,
} from '../index';
import { DIAMOND_ABI } from '../../helpers/abi';
import { getTrackedOrderIds, untrackOrderIds } from '../../utils/orderTracker';
import { safeSend } from '../../helpers/safeSend';
import { withTimeout } from '../../helpers/provider';

// BullMQ renews lock every lockDuration/2 while the job is running.
// Truly stuck jobs get reclaimed after 3 min.
const LOCK_DURATION_MS = 180_000; // 3 min
const JOB_TIMEOUT_MS = 150_000;   // 2.5 min: hard deadline so worker never stalls indefinitely
const BATCH_CONCURRENCY = 20;     // parallel RPC calls per batch
const STATUS_CANCELLED_OR_COMPLETE_THRESHOLD = 3; // status >= 3 => done

export function startOrderSweeperWorker(config: OrderSweeperConfig) {
    const signer = getOrderSweeperSigner(config);
    const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, signer);

    initOrderSweeperQueue();

    const worker = new Worker(
        ORDER_SWEEPER_QUEUE_NAME,
        async (_job) => {
            const timeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`job timeout after ${JOB_TIMEOUT_MS}ms`)), JOB_TIMEOUT_MS),
            );

            await Promise.race([
                (async () => {
                    const ids = await getTrackedOrderIds();
                    if (!ids.length) {
                        logger.debug('🧹 order-sweeper: no tracked orders');
                        return;
                    }

                    logger.info(`🧹 order-sweeper: checking ${ids.length} tracked orders`);

                    const completedIds: string[] = [];   // completed / cancelled
                    const expiredIds: string[] = [];     // should be cancelled via autoCancelExpiredOrders

                    // Process in parallel batches to avoid serial RPC bottleneck on large order sets
                    for (let i = 0; i < ids.length; i += BATCH_CONCURRENCY) {
                        const batch = ids.slice(i, i + BATCH_CONCURRENCY);

                        const results = await Promise.allSettled(
                            batch.map(async (id) => {
                                // Per-call timeout so a single hung RPC doesn't freeze the entire batch
                                const order = await withTimeout(diamond.getOrdersById(id), 8000);
                                const expired: boolean = order && Number(order.status) < STATUS_CANCELLED_OR_COMPLETE_THRESHOLD
                                    ? await withTimeout(diamond.isOrderExpired(id), 8000)
                                    : false;
                                return { id, order, expired };
                            }),
                        );

                        for (const result of results) {
                            if (result.status === 'rejected') {
                                logger.warn(`❌ order-sweeper: check failed for a batch item: ${result.reason?.message ?? result.reason}`);
                                continue;
                            }

                            const { id, order, expired } = result.value;

                            if (!order || Number(order.status) >= STATUS_CANCELLED_OR_COMPLETE_THRESHOLD) {
                                logger.debug(`🧹▶️ order-sweeper: order ${id} is in COMPLETED/CANCELLED status, will be untracked`);
                                completedIds.push(id);
                            } else if (expired) {
                                logger.debug(`🧹▶️ order-sweeper: order ${id} is expired, will be cancelled`);
                                expiredIds.push(id);
                            }
                        }
                    }

                    // Untrack completed / finished orders immediately
                    if (completedIds.length) {
                        await untrackOrderIds(completedIds);
                        logger.info(
                            `✅ order-sweeper: untracked ${completedIds.length} completed orders`,
                        );
                    }

                    // For expired orders, only untrack if cancel tx was sent "successfully"
                    if (!expiredIds.length) {
                        logger.info('🧹 order-sweeper: no expired orders to cancel');
                        return;
                    }

                    logger.info(
                        `🧹 order-sweeper: cancelling ${expiredIds.length} expired orders orderIds=${expiredIds.join(',')}`,
                    );

                    try {
                        const ok = await safeSend(
                            diamond,
                            'autoCancelExpiredOrders',
                            [expiredIds],
                            config,
                            { source: 'sweeper', orderIds: expiredIds },
                        );

                        if (ok) {
                            // staticCall ok + tx accepted -> stop tracking these
                            await untrackOrderIds(expiredIds);
                            logger.info(
                                `✅ order-sweeper: untracked ${expiredIds.length} expired orders after successful send`,
                            );
                        } else {
                            // safeSend returned false (e.g. staticCall failed) -> keep orders tracked
                            logger.warn(
                                '❌ order-sweeper: safeSend returned false; keeping expired orders tracked for retry',
                            );
                        }
                    } catch (err: any) {
                        // safeSend threw (send error, etc.) → keep orders tracked
                        logger.error(
                            `❌ order-sweeper: safeSend threw; keeping expired orders tracked. error=${err.message}`,
                        );
                        throw err; // let BullMQ mark job failed, but repeat will run again next minute
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
        logger.error(`❌ order-sweeper: worker error: ${err?.message}`),
    );

    worker.on('completed', (job) =>
        logger.info(`✅ order-sweeper: completed jobId=${job.id} ${job.name}`),
    );

    worker.on('failed', (job, err) =>
        logger.warn(
            `❌ order-sweeper: failed jobId=${job?.id} ${job?.name}: ${err?.message}`,
        ),
    );

    logger.info('🧹 order-sweeper: started');
}
