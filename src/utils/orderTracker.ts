import { connection } from '../queue';
import { logger } from '../helpers/logger';
import { getBaseHttpProvider } from '../helpers/provider';
import { getPendingOrdersFromLogs } from './fetchPendingOrders';
import { CommonConfig } from '../helpers/config';

const KEY = 'autocancel:orders';

export async function trackOrderId(orderId: string) {
    if (!orderId) return;
    await connection.sadd(KEY, orderId);
}

export async function untrackOrderIds(ids: string[]) {
    if (!ids.length) return;
    await connection.srem(KEY, ...ids);
}

export async function getTrackedOrderIds(): Promise<string[]> {
    const ids = await connection.smembers(KEY);
    return ids ?? [];
}

export async function trackOrderIds(orderIds: string[]) {
    if (!orderIds.length) return;
    await connection.sadd(KEY, ...orderIds);
}

/**
 * Sync Redis-tracked orderIds with chain logs:
 * - looks back `lookbackBlocks`
 * - finds active orders from OrderPlaced logs
 * - unions them into the tracked set (does NOT clear existing)
 */
export async function syncOrderIds(
    config: CommonConfig,
    lookbackBlocks: number,
): Promise<void> {
    if (lookbackBlocks <= 0) return;

    const provider = getBaseHttpProvider(config);
    const latestBlock = await provider.getBlockNumber();
    const fromBlock = Math.max(0, latestBlock - lookbackBlocks);

    const ids = await getPendingOrdersFromLogs(config, fromBlock, latestBlock);
    if (!ids.length) {
        logger.debug(
            `syncOrderIds: no active orders found from logs (lookback=${lookbackBlocks} blocks)`,
        );
        return;
    }

    await trackOrderIds(ids);

    logger.info(
        `syncOrderIds: tracked ${ids.length} active orders from logs (blocks ${fromBlock} to ${latestBlock})`,
    );
}
