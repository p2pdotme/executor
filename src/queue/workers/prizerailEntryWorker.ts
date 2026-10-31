import { Worker } from 'bullmq';
import { ExecutorConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import { sendOnFail } from '../../helpers/alerts';
import { connection } from '../index';
import { initPrizerailEntryQueue, PRIZERAIL_ENTRY_QUEUE_NAME } from '../prizerailQueues';
import { PRIZERAIL_ENTRY_JOB_NAME, PrizerailEntryJobData } from '../types';
import { PrizerailClient } from '../../prizerail/client';
import { classifyEntryFailure } from '../../prizerail/failures';
import { entrantIdFor } from '../../prizerail/entries';
import { getPrizerailStore } from '../../prizerail/db';
import type { PrizerailConfig } from '../../prizerail/config';

const LOCK_DURATION_MS = 60_000;
// Plain HTTPS calls with no shared nonce, so a little parallelism is safe.
const CONCURRENCY = 2;
// BullMQ already backs off between job attempts; keep HTTP-level retries
// short so a 429 is not amplified (2 × 8 = 16 calls worst case, not 24+).
const CLIENT_MAX_ATTEMPTS = 2;

export function eventIdForOrder(orderId: string): string {
    return `order-${orderId}`;
}

// Entries are not chain transactions, so DRY_RUN does not gate them against
// the sandbox: that is exactly where an operator wants to see them land. With
// a production key, DRY_RUN still means "touch nothing real".
export function shouldSkipForDryRun(dryRun: boolean, isSandbox: boolean): boolean {
    return dryRun && !isSandbox;
}

async function sendEntry(
    data: PrizerailEntryJobData,
    config: ExecutorConfig,
    prizerail: PrizerailConfig,
    client: PrizerailClient,
): Promise<void> {
    const { orderId, user, entries } = data;
    if (!Number.isInteger(entries) || entries <= 0) {
        logger.debug(`prizerail-entry: orderId=${orderId} entries=${entries} → nothing to send`);
        return;
    }

    const entrantId = entrantIdFor(user, prizerail.entrantHmacKey);
    if (shouldSkipForDryRun(config.dryRun, prizerail.isSandbox)) {
        logger.info(
            `prizerail-entry[DRY_RUN]: would send orderId=${orderId} entries=${entries} entrant=${entrantId.slice(0, 12)}…`,
        );
        return;
    }

    // Record the reverse map BEFORE the call: if we crash between the two,
    // a retry re-sends (deduped by eventId) and the map is already there.
    await getPrizerailStore(config).rememberEntrant(prizerail.campaignSlug, entrantId, user);

    const res = await client.sendIncrementEntries([
        { entrantId, entries, eventId: eventIdForOrder(orderId) },
    ]);
    const outcome = res.duplicates > 0 ? 'duplicate (already counted)' : 'counted';
    logger.info(
        `prizerail-entry: orderId=${orderId} entries=${entries} → ${outcome} drawing=${res.drawing?.id ?? '?'} cutoff=${res.drawing?.cutoffAt ?? '?'} drawingEntrants=${res.entrantCount ?? '?'} drawingEntries=${res.totalEntries ?? '?'}`,
    );
}

export function startPrizerailEntryWorker(config: ExecutorConfig): void {
    const prizerail = config.prizerail;
    if (!prizerail) {
        logger.info('prizerail-entry: PRIZERAIL_API_KEY unset — worker not started');
        return;
    }

    initPrizerailEntryQueue();
    const client = new PrizerailClient({
        baseUrl: prizerail.baseUrl,
        apiKey: prizerail.apiKey,
        campaignSlug: prizerail.campaignSlug,
        maxAttempts: CLIENT_MAX_ATTEMPTS,
    });

    const worker = new Worker<PrizerailEntryJobData>(
        PRIZERAIL_ENTRY_QUEUE_NAME,
        async (job) => {
            if (job.name !== PRIZERAIL_ENTRY_JOB_NAME) {
                const msg = `prizerail-entry: unexpected job ${job.name} jobId= ${job.id}`;
                logger.warn(msg);
                await sendOnFail(config, msg);
                return;
            }
            try {
                await sendEntry(job.data, config, prizerail, client);
            } catch (err: unknown) {
                const kind = classifyEntryFailure(err);
                const reason = err instanceof Error ? err.message : String(err);
                logger.error(`prizerail-entry: orderId=${job.data.orderId} ${kind} failure: ${reason}`);
                if (kind === 'permanent') {
                    // The request itself is wrong (or this eventId is already
                    // taken): retrying cannot help. Alert and complete the job.
                    await sendOnFail(
                        config,
                        `Prizerail entry rejected\norderId= ${job.data.orderId}\nentries= ${job.data.entries}\n↳ ${reason}`,
                    );
                    return;
                }
                // Auth, paused campaign, 429, 5xx, transport: keep the job
                // alive. BullMQ retries with backoff; the final failure is
                // retained (see prizerailQueues) and alerted below.
                throw err;
            }
        },
        { connection, concurrency: CONCURRENCY, lockDuration: LOCK_DURATION_MS },
    );

    worker.on('error', (err) => logger.error(`❌ prizerail-entry: worker error: ${err?.message}`));
    worker.on('failed', (job, err) => {
        const msg = `❌ prizerail-entry: failed jobId= ${job?.id} attempt= ${job?.attemptsMade}/${job?.opts.attempts ?? 1}: ${err?.message}`;
        logger.warn(msg);
        if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
            void sendOnFail(
                config,
                `Prizerail entry gave up after retries — job retained for manual retry\n${msg}`,
            ).catch(() => {});
        }
    });

    logger.info(
        `▶️ prizerail-entry: started (campaign=${prizerail.campaignSlug} ${prizerail.isSandbox ? 'SANDBOX' : 'PRODUCTION'} base=${prizerail.baseUrl})`,
    );
}
