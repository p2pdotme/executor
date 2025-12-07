import { ContractCallerConfig } from '../helpers/config';
import { logger } from '../helpers/logger';
import { fetchPendingOrderIdsFromSubgraph } from './fetchPendingOrders';
import { trackOrderIds } from '../utils/orderTracker';

export async function seedPendingOrdersToOrderSweeper(config: ContractCallerConfig) {
    const now = Math.floor(Date.now() / 1000);
    const from = now - 60 * 60; // last 1 hour
    const to = now;

    const ids = await fetchPendingOrderIdsFromSubgraph(config, from, to);
    if (!ids.length) {
        logger.info('order-sweeper seed: no pending orders from subgraph');
        return;
    }

    await trackOrderIds(ids);
    logger.info(
        `order-sweeper seed: tracked ${ids.length} pending orders from subgraph`,
    );
}
