import { Queue, Job } from 'bullmq';
import IORedis from 'ioredis';
import { ExecutorConfig } from '../helpers/config';
import { ContractJobData, SettleClaimJobData, SETTLE_CLAIM_JOB_NAME } from './types';
import { logger } from '../helpers/logger';

export const TOGGLE_QUEUE_NAME = 'toggle-calls';
export const ASSIGN_QUEUE_NAME = 'assign-calls';
export const ORDER_SWEEPER_QUEUE_NAME = 'order-sweeper-calls';
export const ORDER_SCANNER_QUEUE_NAME = 'order-scanner-calls';
// B2B cashback programme — see queue/workers/cashbackWorker.ts.
export const CASHBACK_QUEUE_NAME = 'cashback-calls';
// Everything signed by the Keeper wallet. Carries BOTH the once-a-day keeper run
// ('DailyKeeper'/'DailyKeeperStartup') and the insurance settlement jobs
// ('SettleClaim'). Deliberately one queue: its concurrency:1 worker is the only
// consumer of the shared Keeper NonceManager, so a settle can never interleave
// with the daily run and trip safeSend's signer.reset(). See dailyKeeperWorker.ts.
export const DAILY_KEEPER_QUEUE_NAME = 'daily-keeper-calls';
// Subgraph reconciliation tick that enqueues overdue/missed claims onto the
// keeper queue. Read-only (no tx, no wallet), so it keeps its own queue and can
// run concurrently with a settle. See settleClaimScannerWorker.ts.
export const SETTLE_CLAIM_SCANNER_QUEUE_NAME = 'settle-claim-scanner-calls';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';
export const connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    retryStrategy(times) {
        return Math.min(times * 2000, 10000); // retry every 2–10s
    },
});

// separate queues per wallet / responsibility
export let toggleQueue: Queue<ContractJobData>;
export let assignQueue: Queue<ContractJobData>;
export let orderSweeperQueue: Queue<any>;
export let orderScannerQueue: Queue<any>;
export let cashbackQueue: Queue<ContractJobData>;
export let dailyKeeperQueue: Queue<any>;
export let settleClaimScannerQueue: Queue<any>;

export function initToggleQueue(_config?: ExecutorConfig) {
    if (!toggleQueue) {
        toggleQueue = new Queue<ContractJobData>(TOGGLE_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                removeOnFail: { count: 100 },
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 },
            },
        });
        logger.info(`queue: ${TOGGLE_QUEUE_NAME} initialised`);
    }

    return toggleQueue;
}

export function initAssignQueue(_config?: ExecutorConfig) {
    if (!assignQueue) {
        assignQueue = new Queue<ContractJobData>(ASSIGN_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                removeOnFail: { count: 100 },
                attempts: 3,
                backoff: { type: 'exponential', delay: 1000 },
            },
        });
        logger.info(`queue: ${ASSIGN_QUEUE_NAME} initialised`);
    }

    return assignQueue;
}

export function initOrderSweeperQueue() {
    if (!orderSweeperQueue) {
        orderSweeperQueue = new Queue<any>(ORDER_SWEEPER_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
            },
        });
        logger.info(`queue: ${ORDER_SWEEPER_QUEUE_NAME} initialised`);
    }
    return orderSweeperQueue;
}

export function initCashbackQueue() {
    if (!cashbackQueue) {
        cashbackQueue = new Queue<ContractJobData>(CASHBACK_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                removeOnFail: { count: 100 },
                // 5 attempts with exponential backoff — issueCredit is gated to a
                // single whitelisted wallet and the txs are tiny, so transient
                // RPC/nonce issues are the only realistic failure mode. A
                // permanent revert (e.g. issuer not whitelisted) blows through
                // all attempts and lands in DLQ via removeOnFail.
                attempts: 5,
                backoff: { type: 'exponential', delay: 2000 },
            },
        });
        logger.info(`queue: ${CASHBACK_QUEUE_NAME} initialised`);
    }
    return cashbackQueue;
}

export function initDailyKeeperQueue() {
    if (!dailyKeeperQueue) {
        dailyKeeperQueue = new Queue<any>(DAILY_KEEPER_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                // MUST be `true`, not a retained count. BullMQ's jobId dedupe keys
                // off the job hash EXISTING in any state, so a retained failed job
                // silently swallows every later re-enqueue of the same jobId. Both
                // producers on this queue use fixed jobIds — 'daily-keeper-startup'
                // and 'settle-<claimId>' — so a retained failure would disable the
                // startup run for every future restart, or strand that claim
                // forever. Evicting on failure lets the next tick recover.
                removeOnFail: true,
                // The daily job is fully idempotent (re-validates everything
                // on-chain), so a single run is cheap to retry on transient
                // RPC/subgraph hiccups. Settle jobs override this per-job.
                attempts: 2,
                backoff: { type: 'exponential', delay: 10000 },
            },
        });
        logger.info(`queue: ${DAILY_KEEPER_QUEUE_NAME} initialised`);
    }
    return dailyKeeperQueue;
}

export function initSettleClaimScannerQueue() {
    if (!settleClaimScannerQueue) {
        settleClaimScannerQueue = new Queue<any>(SETTLE_CLAIM_SCANNER_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                // Same reason as the settle queue: the startup one-shot uses a
                // fixed jobId, so a retained failure would kill boot-time
                // reconciliation for every subsequent restart.
                removeOnFail: true,
                attempts: 2,
                backoff: { type: 'exponential', delay: 10000 },
            },
        });
        logger.info(`queue: ${SETTLE_CLAIM_SCANNER_QUEUE_NAME} initialised`);
    }
    return settleClaimScannerQueue;
}

export function initOrderScannerQueue() {
    if (!orderScannerQueue) {
        orderScannerQueue = new Queue<any>(ORDER_SCANNER_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                removeOnFail: { count: 100 },
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
            },
        });
        logger.info(`queue: ${ORDER_SCANNER_QUEUE_NAME} initialised`);
    }
    return orderScannerQueue;
}


// enqueue helpers
export async function addToggleJob(
    config: ExecutorConfig,
    name: string,
    data: ContractJobData,
    opts?: { delayMs?: number; jobId?: string },
) {
    const queue = initToggleQueue(config);
    const delay = opts?.delayMs ?? 0;

    const job: Job<ContractJobData> = await queue.add(
        name,
        data,
        {
            delay,
            jobId: opts?.jobId,
        },
    );

    logger.info(
        `queue(${TOGGLE_QUEUE_NAME}): added job name= ${name} jobId= ${job.id} delayMs= ${delay}`,
    );

    return job;
}

export async function addAssignJob(
    config: ExecutorConfig,
    name: string, // expected: 'AssignMerchants' | 'GetOrdersById'
    data: ContractJobData,
    opts?: { delayMs?: number; jobId?: string },
) {
    const queue = initAssignQueue(config);
    const delay = opts?.delayMs ?? 0;

    const job: Job<ContractJobData> = await queue.add(
        name,
        data,
        {
            delay,
            jobId: opts?.jobId,
        },
    );

    // Detect silent deduplication: BullMQ returns the existing job without error when jobId matches
    const state = await job.getState();
    if (state !== 'delayed' && state !== 'waiting') {
        logger.warn(
            `queue(${ASSIGN_QUEUE_NAME}): job DEDUPED — jobId= ${job.id} already exists in state= ${state}, NOT enqueued as new`,
        );
    } else {
        logger.info(
            `queue(${ASSIGN_QUEUE_NAME}): added job name= ${name} jobId= ${job.id} delayMs= ${delay}`,
        );
    }

    return job;
}

// Settles ride the daily-keeper queue so the Keeper wallet keeps exactly one
// consumer — see DAILY_KEEPER_QUEUE_NAME above and dailyKeeperWorker.ts.
export async function addSettleClaimJob(
    data: SettleClaimJobData,
    opts?: { delayMs?: number; jobId?: string },
) {
    const queue = initDailyKeeperQueue();
    const delay = opts?.delayMs ?? 0;

    const job: Job<SettleClaimJobData> = await queue.add(
        SETTLE_CLAIM_JOB_NAME,
        data,
        {
            delay,
            // jobId pins idempotency to the claimId — see claimApproved listener
            // and the reconciliation scanner. A ClaimApproved replay (WS
            // reconnect) or an overlap between the delayed WS job and the scanner
            // returns the existing job instead of enqueueing a duplicate, so
            // settleClaim is at-most-once-in-flight per claim. `settle-` prefixed
            // ids can't collide with the daily run's own fixed ids.
            jobId: opts?.jobId,
            // settleClaim is idempotent (the handler presims status/delay/auth on
            // every run), so transient RPC/nonce hiccups are the only realistic
            // failure worth retrying. A permanent revert is caught in presim and
            // returns without throwing — no retry, no wasted gas. Overrides the
            // queue default of 2, which is tuned for the daily run.
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
        },
    );

    const state = await job.getState();
    if (state === 'failed') {
        // Should be unreachable — the queue sets removeOnFail:true precisely so a
        // failed job can't shadow a re-enqueue. If it ever fires, the claim is
        // stuck and no scanner tick will recover it.
        logger.warn(
            `queue(${DAILY_KEEPER_QUEUE_NAME}): settle re-enqueue SHADOWED by a retained failed job — jobId= ${job.id} claimId= ${data.claimId}; claim will NOT settle until it is removed`,
        );
    } else if (state !== 'delayed' && state !== 'waiting') {
        logger.info(
            `queue(${DAILY_KEEPER_QUEUE_NAME}): settle job DEDUPED — jobId= ${job.id} already in state= ${state} (OK — settle fires once per claim)`,
        );
    } else {
        logger.info(
            `queue(${DAILY_KEEPER_QUEUE_NAME}): added settle job jobId= ${job.id} claimId= ${data.claimId} delayMs= ${delay}`,
        );
    }

    return job;
}

export async function addCashbackJob(
    name: string, // expected: 'IssueCashbackCredit'
    data: ContractJobData,
    opts?: { jobId?: string },
) {
    const queue = initCashbackQueue();

    const job: Job<ContractJobData> = await queue.add(
        name,
        data,
        {
            // jobId pins idempotency to the orderId — see orderCompleted
            // listener. A duplicate event for the same orderId (e.g. WS
            // reconnect replay) returns the existing job state instead of
            // re-enqueueing, so issueCredit is at-most-once per order.
            jobId: opts?.jobId,
        },
    );

    const state = await job.getState();
    if (state !== 'waiting' && state !== 'delayed') {
        logger.info(
            `queue(${CASHBACK_QUEUE_NAME}): job DEDUPED — jobId= ${job.id} already in state= ${state} (this is OK — cashback should fire once per order)`,
        );
    } else {
        logger.info(
            `queue(${CASHBACK_QUEUE_NAME}): added job name= ${name} jobId= ${job.id}`,
        );
    }

    return job;
}
