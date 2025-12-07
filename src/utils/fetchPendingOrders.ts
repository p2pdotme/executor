import { ContractCallerConfig } from '../helpers/config';
import { logger } from '../helpers/logger';

type SubgraphPending = {
    order_id: string;
};

export async function fetchPendingOrderIdsFromSubgraph(
    config: ContractCallerConfig
): Promise<string[]> {
    if (!config.subgraphUrl) {
        logger.warn('subgraph: SUBGRAPH_URL not configured; returning empty list');
        return [];
    }

    const now = Math.floor(Date.now() / 1000);
    const placedLt = now - 30 * 60;      // now - 30 minutes
    const placedGt = now - 3 * 60 * 60;  // now - 3 hours

    const query = `
        query PendingOrders($gt: String!, $lt: String!) {
            orders_collection(
            where: {
                placed_at_gt: $gt,
                placed_at_lt: $lt,
                status_lt: 3
            }
            ) {
            order_id
            }
        }
    `;

    const variables = {
        gt: placedGt.toString(),
        lt: placedLt.toString(),
    };

    try {
        const res = await fetch(config.subgraphUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query, variables }),
        });

        if (!res.ok) {
            const text = await res.text();
            logger.error({ status: res.status, body: text }, 'subgraph: HTTP error');
            return [];
        }

        const json = await res.json();
        const rows: SubgraphPending[] = json.data?.orders_collection ?? [];
        const ids = rows.map((r) => String(r.order_id));
        return ids;
    } catch (err: any) {
        logger.error(`subgraph: request failed ${String(err?.message ?? err)}`);
        return [];
    }
}
