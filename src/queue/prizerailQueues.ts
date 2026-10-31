import { Queue, Job } from 'bullmq';
import { connection } from './index';
import { logger } from '../helpers/logger';
import {
    PRIZERAIL_ENTRY_JOB_NAME,
    PRIZERAIL_PAYOUT_JOB_NAME,
    PrizerailEntryJobData,
    PrizerailPayoutJobData,
} from './types';

// One job per eligible order: POST increment-mode entries to Prizerail.
// No wallet, no tx — only an HTTPS call — so it runs on its own queue and
// never contends with the signing workers.
export const PRIZERAIL_ENTRY_QUEUE_NAME = 'prizerail-entry-calls';
// Periodic read of settled/paid drawings → winner ledger + Discord alert.
export const PRIZERAIL_PAYOUT_SCANNER_QUEUE_NAME = 'prizerail-payout-scanner-calls';
// USDC transfers from the prize wallet. Its own queue with ONE consumer:
// the only writer to the Prize NonceManager (same rule as the keeper).
export const PRIZERAIL_PAYOUT_QUEUE_NAME = 'prizerail-payout-calls';

let prizerailEntryQueue: Queue<PrizerailEntryJobData> | undefined;
let prizerailPayoutScannerQueue: Queue<Record<string, never>> | undefined;
let prizerailPayoutQueue: Queue<PrizerailPayoutJobData> | undefined;

export function initPrizerailEntryQueue(): Queue<PrizerailEntryJobData> {
    if (!prizerailEntryQueue) {
        prizerailEntryQueue = new Queue<PrizerailEntryJobData>(PRIZERAIL_ENTRY_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                // Failed jobs are RETAINED on purpose. The jobId is the orderId,
                // so a retained failure shadows any later re-enqueue of the same
                // order (BullMQ dedupes on existence) — but that failed job IS
                // the retry handle: an operator fixes the cause (rotated key,
                // paused campaign) and retries it from Redis, and Prizerail's
                // eventId dedupe makes that safe even if an earlier attempt
                // actually landed. Permanent 4xx rejections never get here —
                // the worker swallows them after an alert.
                removeOnFail: { count: 500 },
                // 8 attempts × exponential from 5s ≈ 21 minutes of cover for a
                // transient auth/pause/429/5xx condition before giving up.
                attempts: 8,
                backoff: { type: 'exponential', delay: 5000 },
            },
        });
        logger.info(`queue: ${PRIZERAIL_ENTRY_QUEUE_NAME} initialised`);
    }
    return prizerailEntryQueue;
}

export function initPrizerailPayoutScannerQueue(): Queue<Record<string, never>> {
    if (!prizerailPayoutScannerQueue) {
        prizerailPayoutScannerQueue = new Queue<Record<string, never>>(
            PRIZERAIL_PAYOUT_SCANNER_QUEUE_NAME,
            {
                connection,
                defaultJobOptions: {
                    removeOnComplete: true,
                    // Fixed jobIds on this queue — a retained failure would
                    // shadow every later enqueue (see dailyKeeperQueue).
                    removeOnFail: true,
                    attempts: 2,
                    backoff: { type: 'exponential', delay: 10_000 },
                },
            },
        );
        logger.info(`queue: ${PRIZERAIL_PAYOUT_SCANNER_QUEUE_NAME} initialised`);
    }
    return prizerailPayoutScannerQueue;
}

export function initPrizerailPayoutQueue(): Queue<PrizerailPayoutJobData> {
    if (!prizerailPayoutQueue) {
        prizerailPayoutQueue = new Queue<PrizerailPayoutJobData>(PRIZERAIL_PAYOUT_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                // The ledger row, not the job, is the source of truth: the
                // scanner re-queues anything still pending on every tick, so
                // a failed job can be dropped without losing the payout.
                removeOnFail: true,
                // Empty prize wallet / RPC trouble: back off for a while, then
                // let the next scanner tick re-queue.
                attempts: 4,
                backoff: { type: 'exponential', delay: 30_000 },
            },
        });
        logger.info(`queue: ${PRIZERAIL_PAYOUT_QUEUE_NAME} initialised`);
    }
    return prizerailPayoutQueue;
}

export async function addPrizerailPayoutJob(data: PrizerailPayoutJobData): Promise<Job<PrizerailPayoutJobData>> {
    const queue = initPrizerailPayoutQueue();
    // jobId = ledger primary key: an in-flight payout for this winner is
    // never duplicated. Once complete the job is removed, and the worker's
    // claimPayout guard makes any later re-add a no-op.
    const job = await queue.add(PRIZERAIL_PAYOUT_JOB_NAME, data, {
        jobId: `prizerail-payout-${data.campaign}-${data.drawingId}-${data.position}`,
    });
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed') {
        logger.info(`queue(${PRIZERAIL_PAYOUT_QUEUE_NAME}): queued payout ${data.drawingId}#${data.position}`);
    }
    return job;
}

export async function addPrizerailEntryJob(data: PrizerailEntryJobData): Promise<Job<PrizerailEntryJobData>> {
    const queue = initPrizerailEntryQueue();
    // jobId pins idempotency to the orderId, like the cashback queue. A WS
    // replay returns the existing job instead of a duplicate; Prizerail's
    // eventId dedupe is the second line of defence.
    const job = await queue.add(PRIZERAIL_ENTRY_JOB_NAME, data, {
        jobId: `prizerail-${data.orderId}`,
    });

    const state = await job.getState();
    if (state !== 'waiting' && state !== 'delayed') {
        logger.info(
            `queue(${PRIZERAIL_ENTRY_QUEUE_NAME}): job DEDUPED — jobId= ${job.id} already in state= ${state} (OK — one entry event per order)`,
        );
    } else {
        logger.info(
            `queue(${PRIZERAIL_ENTRY_QUEUE_NAME}): added job jobId= ${job.id} entries= ${data.entries}`,
        );
    }
    return job;
}
