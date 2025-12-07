import { connection } from '../queue';

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
