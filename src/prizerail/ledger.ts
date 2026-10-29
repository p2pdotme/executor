import type IORedis from 'ioredis';
import { flattenRecord, mergeWinnerRecord, WinnerRecord } from './winners';

// Redis-backed winner ledger. One hash per (campaign, drawing, position).
// `claimed` is set with HSETNX so two overlapping ticks (a timed-out job
// retried, or two replicas) cannot both treat a winner as new; `alerted`
// is flipped only after Discord accepted the message, so a lost webhook
// call is retried on the next tick instead of being forgotten.

const CLAIM_FIELD = 'claimed';
const ALERTED_FIELD = 'alerted';

export function winnerKey(slug: string, drawingId: string, position: number): string {
    return `prizerail:winner:${slug}:${drawingId}:${position}`;
}

export function doneDrawingsKey(slug: string): string {
    return `prizerail:drawings:done:${slug}`;
}

export type UpsertResult = {
    fresh: boolean;
    alerted: boolean;
    record: WinnerRecord;
};

export async function upsertWinner(redis: IORedis, slug: string, planned: WinnerRecord): Promise<UpsertResult> {
    const key = winnerKey(slug, planned.drawingId, planned.position);
    const claimed = await redis.hsetnx(key, CLAIM_FIELD, '1');
    if (claimed === 1) {
        await redis.hset(key, { ...flattenRecord(planned), [ALERTED_FIELD]: '0' });
        return { fresh: true, alerted: false, record: planned };
    }
    const existing = await redis.hgetall(key);
    const { patch, effective } = mergeWinnerRecord(existing, planned);
    if (patch) await redis.hset(key, patch);
    return { fresh: false, alerted: existing[ALERTED_FIELD] === '1', record: effective };
}

export async function markAlerted(redis: IORedis, slug: string, records: readonly WinnerRecord[]): Promise<void> {
    for (const r of records) {
        await redis.hset(winnerKey(slug, r.drawingId, r.position), ALERTED_FIELD, '1');
    }
}

export async function isDrawingDone(redis: IORedis, slug: string, drawingId: string): Promise<boolean> {
    return (await redis.sismember(doneDrawingsKey(slug), drawingId)) === 1;
}

export async function markDrawingDone(redis: IORedis, slug: string, drawingId: string): Promise<void> {
    await redis.sadd(doneDrawingsKey(slug), drawingId);
}
