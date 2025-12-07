import { Worker } from 'bullmq';
import { Contract } from 'ethers';
import { ContractCallerConfig } from '../../helpers/config';
import { getOrderScannerSigner } from '../../helpers/provider';
import { logger } from '../../helpers/logger';
import {
    ORDER_SCANNER_QUEUE_NAME,
    initOrderScannerQueue,
    connection,
} from '../index';
import { DIAMOND_ABI } from '../../helpers/abi';
import { safeSend } from '../../helpers/safeSend';
import { fetchPendingOrderIdsFromSubgraph } from '../../utils/fetchPendingOrders';

const LOCK_DURATION_MS = 30_000; // 30s

export function startOrderScannerWorker(config: ContractCallerConfig) {
    const signer = getOrderScannerSigner(config);
    const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, signer);

    initOrderScannerQueue();

    const worker = new Worker(
        ORDER_SCANNER_QUEUE_NAME,
        async (_job) => {
            const ids = await fetchPendingOrderIdsFromSubgraph(config);
            if (!ids.length) {
                logger.info('🔍 order-scanner: no pending orders from subgraph');
                return;
            }

            logger.info(`🔍 order-scanner: cancelling ${ids.length} expired orders orderIds=${ids.join(',')}`);

            const ok = await safeSend(
                diamond,
                'autoCancelExpiredOrders',
                [ids],
                config,
                { source: 'scanner', count: ids.length },
            );

            if (!ok) {
                logger.warn(
                    `❌ order-scanner: safeSend returned false; no tx sent / reverted for ${ids.length} orders`,
                );
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
        logger.info(
            `✅ order-scanner: completed jobId=${job.id} ${job.name}`,
        ),
    );

    worker.on('failed', (job, err) =>
        logger.warn(
            `❌ order-scanner: failed jobId=${job?.id} ${job?.name}: ${err?.message}`,
        ),
    );

    logger.info('🔍 order-scanner: started');
}
