import { Queue, Job } from 'bullmq';
import IORedis from 'ioredis';
import { ExecutorConfig } from '../helpers/config';
import { ContractJobData } from './types';
import { logger } from '../helpers/logger';

export const TOGGLE_QUEUE_NAME = 'toggle-calls';
export const ASSIGN_QUEUE_NAME = 'assign-calls';
export const ORDER_SWEEPER_QUEUE_NAME = 'order-sweeper-calls';
export const ORDER_SCANNER_QUEUE_NAME = 'order-scanner-calls';
// B2B cashback programme — see queue/workers/cashbackWorker.ts.
export const CASHBACK_QUEUE_NAME = 'cashback-calls';
// Daily permissionless keeper — see queue/workers/dailyKeeperWorker.ts.
export const DAILY_KEEPER_QUEUE_NAME = 'daily-keeper-calls';
// Hourly circle-registry refresh — see queue/workers/circleRefreshWorker.ts.
export const CIRCLE_REFRESH_QUEUE_NAME = 'circle-refresh-calls';

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
export let circleRefreshQueue: Queue<any>;

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
                removeOnFail: { count: 100 },
                // The job is fully idempotent (re-validates everything on-chain),
                // but a single daily run is cheap to retry on transient RPC/subgraph hiccups.
                attempts: 2,
                backoff: { type: 'exponential', delay: 10000 },
            },
        });
        logger.info(`queue: ${DAILY_KEEPER_QUEUE_NAME} initialised`);
    }
    return dailyKeeperQueue;
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

export function initCircleRefreshQueue() {
    if (!circleRefreshQueue) {
        circleRefreshQueue = new Queue<any>(CIRCLE_REFRESH_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                removeOnFail: { count: 100 },
                // One retry only. A refresh that fails leaves the previous list
                // in Redis and the next tick is an hour away, so there is no
                // point grinding on a notifier that is down.
                attempts: 2,
                backoff: { type: 'exponential', delay: 5000 },
            },
        });
        logger.info(`queue: ${CIRCLE_REFRESH_QUEUE_NAME} initialised`);
    }
    return circleRefreshQueue;
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
