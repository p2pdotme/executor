import type IORedis from 'ioredis';

// Entrant ids are one-way HMACs of the wallet (prizerail/entries.ts). To pay
// a winner we need the inverse, so every entry we send first records
// entrantId → wallet here. Keyed per campaign so a second campaign (or a key
// rotation that changes every id) never reads another campaign's map.
export function entrantMapKey(campaignSlug: string): string {
    return `prizerail:entrants:${campaignSlug}`;
}

export async function rememberEntrant(
    redis: IORedis,
    campaignSlug: string,
    entrantId: string,
    wallet: string,
): Promise<void> {
    await redis.hset(entrantMapKey(campaignSlug), entrantId, wallet.toLowerCase());
}

export async function resolveEntrants(
    redis: IORedis,
    campaignSlug: string,
    entrantIds: readonly string[],
): Promise<Record<string, string | null>> {
    if (entrantIds.length === 0) return {};
    const values = await redis.hmget(entrantMapKey(campaignSlug), ...entrantIds);
    return Object.fromEntries(entrantIds.map((id, i) => [id, values[i] ?? null]));
}
