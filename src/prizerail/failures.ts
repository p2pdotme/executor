import { PrizerailApiError } from './client';

export type EntryFailureKind = 'permanent' | 'transient';

// Statuses where the request itself is wrong: resending the same body can
// never succeed, so the job is dropped (with an alert) instead of retried.
const PERMANENT_STATUSES = new Set([400, 404, 422]);
// 409 codes that are permanent for THIS event. Every other 409 (campaign
// paused, drawing full, not taking entries) can clear on its own.
const PERMANENT_CODES = new Set(['event_conflict', 'campaign_ended', 'bad_request', 'not_found']);

/**
 * Decide whether a failed entry send is worth retrying. Anything not provably
 * permanent is transient: a 401/403 from a rotated key, a paused campaign,
 * a 429, a 5xx, or a transport error should all keep the job alive so the
 * entry is not lost while an operator fixes the cause.
 */
export function classifyEntryFailure(err: unknown): EntryFailureKind {
    if (!(err instanceof PrizerailApiError)) return 'transient';
    if (PERMANENT_STATUSES.has(err.status)) return 'permanent';
    if (PERMANENT_CODES.has(err.code)) return 'permanent';
    return 'transient';
}
