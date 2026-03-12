import { Worker } from 'bullmq';
import { Contract } from 'ethers';
import { ToggleConfig } from '../../helpers/config';
import { getToggleSigner } from '../../helpers/provider';
import { logger } from '../../helpers/logger';
import { handlers, HandlerContext } from '../handlers';
import { ContractJobName, ContractJobData } from '../types';
import { initToggleQueue, connection } from '../index';
import { DIAMOND_ABI } from '../../helpers/abi';
import { sendOnFail } from '../../helpers/alerts';

const TOGGLE_QUEUE_NAME = 'toggle-calls';
// BullMQ renews the lock every lockDuration/2 while the job is running.
// Truly stuck jobs get reclaimed after 3 min.
const LOCK_DURATION_MS = 180_000; // 3 min
const JOB_TIMEOUT_MS = 120_000;   // 2 min: hard deadline so worker never stalls indefinitely

export function startToggleWorker(config: ToggleConfig) {
    const signer = getToggleSigner(config);
    const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, signer);

    initToggleQueue(config);

    const ctx: HandlerContext = { config, diamond };

    const worker = new Worker<ContractJobData>(
        TOGGLE_QUEUE_NAME,
        async (job) => {
            const name = job.name as ContractJobName;

            if (name !== 'ToggleMerchantsOffline') {
                const msg = `toggle-worker: unexpected job ${name} jobId= ${job.id}`;
                logger.warn(msg);
                await sendOnFail(config, msg);
                return;
            }

            const handler = handlers[name];
            if (!handler) {
                const msg = `toggle-worker: no handler for job ${name}`;
                logger.error(msg);
                await sendOnFail(config, msg);
                return;
            }

            logger.info(`▶️ toggle-worker: job start ${name} jobId= ${job.id}`);

            const timeout = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`job timeout after ${JOB_TIMEOUT_MS}ms`)), JOB_TIMEOUT_MS),
            );

            try {
                const ok = await Promise.race([handler(job.data, ctx), timeout]);

                if (!ok) {
                    const msg = `toggle-worker: handler returned false for job ${name} jobId= ${job.id}`;
                    logger.warn(msg);
                    await sendOnFail(config, msg);
                } else {
                    logger.info(`✅ toggle-worker: job ok ${name} jobId= ${job.id}`);
                }
            } catch (err: any) {
                const reason = err?.stack ?? err?.message ?? String(err);
                const msg =
                    `Toggle worker error\nJob= ${name}\nJobId= ${job.id}\nData= ${JSON.stringify(
                        job.data,
                    )}\n\n${reason}`;

                logger.error(msg);
                await sendOnFail(config, msg);
                throw err;
            }
        },
        {
            connection,
            concurrency: 1,
            lockDuration: LOCK_DURATION_MS,
        },
    );

    worker.on('error', (err) =>
        logger.error(`❌ toggle-worker: Worker error: ${err?.message}`),
    );

    worker.on('completed', (job) =>
        logger.info(`✅ toggle-worker: completed jobId= ${job.id} ${job.name}`),
    );

    worker.on('failed', (job, err) =>
        logger.warn(
            `❌ toggle-worker: failed jobId= ${job?.id} ${job?.name}: ${err?.message}`,
        ),
    );

    logger.info('▶️ toggle-worker: started');
}
