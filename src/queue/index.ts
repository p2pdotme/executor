import { Queue, Job } from 'bullmq';
import IORedis from 'ioredis';
import { AssignConfig, ToggleConfig } from '../helpers/config';
import { ContractJobData } from './types';
import { logger } from '../helpers/logger';

export const TOGGLE_QUEUE_NAME = 'toggle-calls';
export const ASSIGN_QUEUE_NAME = 'assign-calls';
export const TOGGLE_SCHEDULE_QUEUE_NAME = 'toggle-schedule-calls';
export const ORDER_SWEEPER_QUEUE_NAME = 'order-sweeper-calls';
export const ORDER_SCANNER_QUEUE_NAME = 'order-scanner-calls';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://redis:6379';
export const connection = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
});

// separate queues per wallet / responsibility
export let toggleQueue: Queue<ContractJobData>;
export let assignQueue: Queue<ContractJobData>;
export let toggleScheduleQueue: Queue<ContractJobData>;
export let orderSweeperQueue: Queue<any>;
export let orderScannerQueue: Queue<any>;

export function initToggleQueue(_config?: ToggleConfig) {
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

export function initAssignQueue(_config?: AssignConfig) {
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

export function initToggleScheduleQueue() {
    if (!toggleScheduleQueue) {
        toggleScheduleQueue = new Queue<ContractJobData>(TOGGLE_SCHEDULE_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                attempts: 3,
            },
        });
        logger.info(`queue: ${TOGGLE_SCHEDULE_QUEUE_NAME} initialised`);
    }
    return toggleScheduleQueue;
}

export function initOrderSweeperQueue() {
    if (!orderSweeperQueue) {
        orderSweeperQueue = new Queue<any>(ORDER_SWEEPER_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                attempts: 3,
            },
        });
        logger.info(`queue: ${ORDER_SWEEPER_QUEUE_NAME} initialised`);
    }
    return orderSweeperQueue;
}

export function initOrderScannerQueue() {
    if (!orderScannerQueue) {
        orderScannerQueue = new Queue<any>(ORDER_SCANNER_QUEUE_NAME, {
            connection,
            defaultJobOptions: {
                removeOnComplete: true,
                attempts: 1,
            },
        });
        logger.info(`queue: ${ORDER_SCANNER_QUEUE_NAME} initialised`);
    }
    return orderScannerQueue;
}


// enqueue helpers
export async function addToggleJob(
    config: ToggleConfig,
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
    config: AssignConfig,
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

    logger.info(
        `queue(${ASSIGN_QUEUE_NAME}): added job name= ${name} jobId= ${job.id} delayMs= ${delay}`,
    );

    return job;
}
