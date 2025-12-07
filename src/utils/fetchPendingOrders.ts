import { ContractCallerConfig } from '../helpers/config';
import { logger } from '../helpers/logger';

type SubgraphPending = {
    order_id: string;
};

export async function fetchPendingOrderIdsFromSubgraph(
    config: ContractCallerConfig,
    from: number,
    to: number
): Promise<string[]> {
    if (!config.subgraphUrl) {
        logger.warn('subgraph: SUBGRAPH_URL not configured; returning empty list');
        return [];
    }

    const query = `
        query PendingOrders($from: String!, $to: String!) {
            orders_collection(
            where: {
                placed_at_gt: $from,
                placed_at_lt: $to,
                status_lt: 3
            }
            ) {
            order_id
            }
        }
    `;

    const variables = {
        from: from.toString(),
        to: to.toString(),
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
