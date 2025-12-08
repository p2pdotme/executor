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

const LOCK_DURATION_MS = 30_000; // 30s
const STATUS_CANCELLED_OR_COMPLETE_THRESHOLD = 3; // status >= 3 => done

export function startOrderSweeperWorker(config: OrderSweeperConfig) {
    const signer = getOrderSweeperSigner(config);
    const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, signer);

    initOrderSweeperQueue();

    const worker = new Worker(
        ORDER_SWEEPER_QUEUE_NAME,
        async (_job) => {
            const ids = await getTrackedOrderIds();
            if (!ids.length) {
                logger.debug('🧹 order-sweeper: no tracked orders');
                return;
            }

            logger.info(`🧹 order-sweeper: checking ${ids.length} tracked orders`);

            const completedIds: string[] = [];   // completed / cancelled
            const expiredIds: string[] = [];     // should be cancelled via autoCancelExpiredOrders

            for (const id of ids) {
                try {
                    const order = await diamond.getOrdersById(id);

                    // no order -> ignore
                    if (!order) {
                        completedIds.push(id);
                        continue;
                    }

                    const status = Number(order.status);

                    // already in terminal state -> untrack
                    if (status >= STATUS_CANCELLED_OR_COMPLETE_THRESHOLD) {
                        logger.debug(`🧹▶️ order-sweeper: order ${id} is in COMPLETED/CANCELLED status, will be untracked`);
                        completedIds.push(id);
                        continue;
                    }

                    // still active -> check expiry
                    const expired: boolean = await diamond.isOrderExpired(id);
                    if (expired) {
                        logger.debug(`🧹▶️ order-sweeper: order ${id} is expired, will be cancelled`);
                        expiredIds.push(id);
                    }
                } catch (err: any) {
                    logger.warn(
                        `❌ order-sweeper: check failed for orderId=${id}: ${err.message}`,
                    );
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
                    { source: 'sweeper', count: expiredIds.length },
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
