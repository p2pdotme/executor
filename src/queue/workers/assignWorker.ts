import { Worker } from 'bullmq';
import { Contract } from 'ethers';
import { AssignConfig } from '../../helpers/config';
import { getAssignSigner } from '../../helpers/provider';
import { logger } from '../../helpers/logger';
import { handlers, HandlerContext } from '../handlers';
import { ContractJobName, ContractJobData } from '../types';
import { initAssignQueue, connection } from '../index';
import { DIAMOND_ABI } from '../../helpers/abi';
import { sendOnFail } from '../../helpers/alerts';

const ASSIGN_QUEUE_NAME = 'assign-calls';
const LOCK_DURATION_MS = 30_000; // 30s

export function startAssignWorker(config: AssignConfig) {
    const signer = getAssignSigner(config);
    const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, signer);

    initAssignQueue(config);

    const ctx: HandlerContext = { config, diamond };

    const worker = new Worker<ContractJobData>(
        ASSIGN_QUEUE_NAME,
        async (job) => {
            const name = job.name as ContractJobName;

            if (name !== 'AssignMerchants' && name !== 'GetOrdersById') {
                const msg = `assign-worker: unexpected job ${name} jobId= ${job.id}`;
                logger.warn(msg);
                await sendOnFail(config, msg);
                return;
            }

            const handler = handlers[name];
            if (!handler) {
                const msg = `assign-worker: no handler for job ${name}`;
                logger.error(msg);
                await sendOnFail(config, msg);
                return;
            }

            logger.info(`▶️ assign-worker: job start ${name} jobId= ${job.id}`);

            try {
                const ok = await handler(job.data, ctx);

                if (!ok) {
                    const msg = `assign-worker: handler returned false for job ${name} jobId= ${job.id}`;
                    logger.warn(msg);
                    await sendOnFail(config, msg);
                } else {
                    logger.info(`✅ assign-worker: job ok ${name} jobId= ${job.id}`);
                }
            } catch (err: any) {
                const reason = err?.stack ?? err?.message ?? String(err);
                const msg =
                    `Assign worker error\nJob= ${name}\nJobId= ${job.id}\nData= ${JSON.stringify(
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
        logger.error(`❌ assign-worker: Worker error: ${err?.message}`),
    );

    worker.on('completed', (job) =>
        logger.info(`✅ assign-worker: completed jobId= ${job.id} ${job.name}`),
    );

    worker.on('failed', (job, err) =>
        logger.warn(
            `❌ assign-worker: failed jobId= ${job?.id} ${job?.name}: ${err?.message}`,
        ),
    );

    logger.info('▶️ assign-worker: started');
}
