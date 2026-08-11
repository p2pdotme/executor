import { Worker } from 'bullmq';
import { ExecutorConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import { CIRCLE_REFRESH_QUEUE_NAME, initCircleRefreshQueue, connection } from '../index';
import { fetchCircleCurrencies, readCachedCurrencies } from '../../helpers/circles';
import { sendOnSuccess } from '../../helpers/alerts';

// One GraphQL query plus a Redis write; the fetch itself is capped at 10s in
// helpers/circles.ts, so nothing here can hold the lock for long.
const LOCK_DURATION_MS = 60_000;

/**
 * Keeps the cached circle registry fresh.
 *
 * The daily keeper already fetches the registry live at the start of each run,
 * so this is not what makes a new currency get swept. What it buys is that the
 * fallback copy in Redis is never more than an hour stale — if the subgraph
 * happens to be down at 03:00 UTC, the keeper falls back to a list from within
 * the hour rather than one from the previous day — and that a newly launched
 * currency is announced to ops when it appears, instead of being noticed a day
 * later in the keeper's log line.
 */
export function startCircleRefreshWorker(config: ExecutorConfig) {
    initCircleRefreshQueue();

    const worker = new Worker(
        CIRCLE_REFRESH_QUEUE_NAME,
        async (_job) => {
            const before = await readCachedCurrencies();
            const after = await fetchCircleCurrencies(config);

            const added = before ? after.filter((c) => !before.includes(c)) : [];
            const removed = before ? before.filter((c) => !after.includes(c)) : [];

            if (added.length || removed.length) {
                const parts = [
                    added.length ? `+${added.join(', ')}` : '',
                    removed.length ? `-${removed.join(', ')}` : '',
                ].filter(Boolean);
                logger.info(
                    `circle-refresh: registry changed ${parts.join(' ')} — now ${after.length} [${after.join(', ')}]`,
                );
                // Ops-visible: a new currency means the keeper's sweep widens on
                // its next run, and it usually means a launch nobody told us about.
                await sendOnSuccess(
                    config,
                    `Circle registry changed: ${parts.join(' ')} — now tracking ${after.length} currencies (${after.join(', ')})`,
                ).catch(() => undefined);
            } else if (!before) {
                // First run after a deploy that found no cache. Not a change, but
                // worth one INFO line — it is the only confirmation that the
                // keeper's fallback copy exists at all.
                logger.info(
                    `circle-refresh: registry cached — ${after.length} currencies [${after.join(', ')}]`,
                );
            } else {
                logger.debug(`circle-refresh: unchanged (${after.length} currencies)`);
            }
        },
        {
            connection,
            concurrency: 1,
            lockDuration: LOCK_DURATION_MS,
        },
    );

    worker.on('error', (err) => logger.error('circle-refresh: worker error: ' + err?.message));
    // Failure is non-fatal: the previous list stays cached and the keeper's own
    // live fetch is independent of this job. Warn, don't alert.
    worker.on('failed', (job, err) =>
        logger.warn(`circle-refresh: failed jobId=${job?.id}: ${err?.message}`),
    );

    logger.info('circle-refresh: started');
}
