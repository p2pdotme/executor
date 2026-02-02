import { Worker } from 'bullmq';
import { Contract } from 'ethers';
import { ToggleScheduleConfig } from '../../helpers/config';
import { getToggleScheduleSigner } from '../../helpers/provider';
import { logger } from '../../helpers/logger';
import {
    TOGGLE_SCHEDULE_QUEUE_NAME,
    initToggleScheduleQueue,
    connection,
} from '../index';
import { DIAMOND_ABI } from '../../helpers/abi';
import { safeSend } from '../../helpers/safeSend';
import { ethers } from 'ethers';

const LOCK_DURATION_MS = 30_000; // 30s

const LIMIT = 300;

export function startToggleScheduleWorker(config: ToggleScheduleConfig) {
    const signer = getToggleScheduleSigner(config);
    const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, signer);

    initToggleScheduleQueue();

    const worker = new Worker(
        TOGGLE_SCHEDULE_QUEUE_NAME,
        async (job) => {
            const currency = job.data.currency as string;

            try {
                logger.info(`▶️ toggle-schedule-worker: scanning non-eligible merchants currency=${currency}`);

                const [prevsResult, targetsResult] =
                    await diamond.getNonEligibleMerchants(currency, LIMIT);

                const prevs = [...prevsResult];
                const targets = [...targetsResult];

                if (!targets || targets.length === 0) {
                    logger.debug(
                        `toggle-schedule-worker: no non-eligible merchants currency=${currency}`,
                    );
                    return;
                }

                await safeSend(
                    diamond,
                    'removeNonEligibleMerchants',
                    [currency, prevs, targets],
                    config,
                    { schedule: true, currency: ethers.decodeBytes32String(currency) as string, merchants: targets },
                );
            } catch (err: any) {
                const msg = `❌ toggle-schedule-worker error currency=${currency}: ${err.message}`;
                logger.error(msg);
                throw err; // BullMQ retry
            }
        },
        {
            connection,
            concurrency: 1,
            lockDuration: LOCK_DURATION_MS,
        },
    );

    worker.on('error', (err) =>
        logger.error(`❌ toggle-schedule-worker: Worker error: ${err?.message}`),
    );

    worker.on('completed', (job) =>
        logger.info(
            `✅ toggle-schedule-worker: completed jobId=${job.id} ${job.name}`,
        ),
    );

    worker.on('failed', (job, err) =>
        logger.warn(
            `❌ toggle-schedule-worker: failed jobId=${job?.id} ${job?.name}: ${err?.message}`,
        ),
    );

    logger.info('▶️ toggle-schedule-worker: started');
}
