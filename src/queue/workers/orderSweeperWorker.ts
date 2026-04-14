import { Worker } from 'bullmq';
import { Contract, Interface } from 'ethers';
import { ExecutorConfig } from '../../helpers/config';
import { getBaseHttpProvider } from '../../helpers/provider';
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
import { getMulticall3 } from '../../helpers/multicall';
import { WalletManager, WalletRole } from '../../helpers/walletManager';

const LOCK_DURATION_MS = 180_000; // 3 min
const STATUS_CANCELLED_OR_COMPLETE_THRESHOLD = 3; // status >= 3 => done
const CANCEL_BATCH_SIZE = 20; // max orders per autoCancelExpiredOrders tx to stay within gas limits

export function startOrderSweeperWorker(config: ExecutorConfig, walletManager: WalletManager) {
    const signer = walletManager.getSigner(WalletRole.Sweeper);
    const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, signer);
    const provider = getBaseHttpProvider(config);
    const multicall3 = getMulticall3(provider);
    const diamondIface = new Interface(DIAMOND_ABI);

    initOrderSweeperQueue();

    const worker = new Worker(
        ORDER_SWEEPER_QUEUE_NAME,
        async (_job) => {
            const ids = await getTrackedOrderIds();
            if (!ids.length) {
                logger.debug('🧹 order-sweeper: no tracked orders');
                return;
            }

            logger.info(`🧹 order-sweeper: checking ${ids.length} tracked orders via Multicall3`);

            // Build one aggregate3 call: 2 calls per order (getOrdersById + isOrderExpired)
            const calls = ids.flatMap(id => [
                {
                    target: config.diamondAddress,
                    allowFailure: true,
                    callData: diamondIface.encodeFunctionData('getOrdersById', [BigInt(id)]),
                },
                {
                    target: config.diamondAddress,
                    allowFailure: true,
                    callData: diamondIface.encodeFunctionData('isOrderExpired', [BigInt(id)]),
                },
            ]);

            let results: any[];
            try {
                results = await withTimeout(multicall3.aggregate3.staticCall(calls), 30_000);
            } catch (err: any) {
                logger.error(`🧹 order-sweeper: Multicall3 failed: ${err.message}`);
                throw err; // BullMQ retry
            }

            const completedIds: string[] = [];
            const expiredIds: string[] = [];

            for (let i = 0; i < ids.length; i++) {
                const id = ids[i];
                const orderResult = results[i * 2];
                const expiredResult = results[i * 2 + 1];

                if (!orderResult.success) {
                    logger.warn(`🧹 order-sweeper: getOrdersById failed for orderId=${id}`);
                    continue;
                }

                let order: any;
                try {
                    [order] = diamondIface.decodeFunctionResult('getOrdersById', orderResult.returnData);
                } catch (err: any) {
                    logger.warn(`🧹 order-sweeper: decode failed for orderId=${id}: ${err.message}`);
                    continue;
                }

                if (!order || Number(order.status) >= STATUS_CANCELLED_OR_COMPLETE_THRESHOLD) {
                    logger.debug(`🧹▶️ order-sweeper: order ${id} is COMPLETED/CANCELLED, will be untracked`);
                    completedIds.push(id);
                    continue;
                }

                if (!expiredResult.success) {
                    logger.warn(`🧹 order-sweeper: isOrderExpired failed for orderId=${id}`);
                    continue;
                }

                let isExpired: boolean;
                try {
                    [isExpired] = diamondIface.decodeFunctionResult('isOrderExpired', expiredResult.returnData);
                } catch (err: any) {
                    logger.warn(`🧹 order-sweeper: decode isExpired failed for orderId=${id}: ${err.message}`);
                    continue;
                }

                if (isExpired) {
                    logger.debug(`🧹▶️ order-sweeper: order ${id} is expired, will be cancelled`);
                    expiredIds.push(id);
                }
            }

            if (completedIds.length) {
                await untrackOrderIds(completedIds);
                logger.info(`✅ order-sweeper: untracked ${completedIds.length} completed orders`);
            }

            if (!expiredIds.length) {
                logger.info('🧹 order-sweeper: no expired orders to cancel');
                return;
            }

            logger.info(`🧹 order-sweeper: cancelling ${expiredIds.length} expired orders orderIds=${expiredIds.join(',')}`);

            // Chunk into batches to avoid hitting block gas limits
            for (let i = 0; i < expiredIds.length; i += CANCEL_BATCH_SIZE) {
                const batch = expiredIds.slice(i, i + CANCEL_BATCH_SIZE);
                try {
                    // skipPresim=true: we already confirmed expiry via isOrderExpired above
                    const ok = await safeSend(
                        diamond,
                        'autoCancelExpiredOrders',
                        [batch],
                        config,
                        { orderIds: batch },
                        true,
                    );

                    if (ok) {
                        await untrackOrderIds(batch);
                        logger.info(`✅ order-sweeper: untracked ${batch.length} expired orders (batch ${Math.floor(i / CANCEL_BATCH_SIZE) + 1})`);
                    } else {
                        logger.warn(`❌ order-sweeper: safeSend returned false for batch starting at index ${i}; keeping tracked for retry`);
                    }
                } catch (err: any) {
                    logger.error(`❌ order-sweeper: safeSend threw for batch at index ${i}; keeping tracked. error=${err.message}`);
                    throw err;
                }
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
        logger.warn(`❌ order-sweeper: failed jobId=${job?.id} ${job?.name}: ${err?.message}`),
    );

    logger.info('🧹 order-sweeper: started');
}
