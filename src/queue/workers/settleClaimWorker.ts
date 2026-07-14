import { Worker } from 'bullmq';
import { Contract } from 'ethers';
import { ExecutorConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import { SETTLE_CLAIM_QUEUE_NAME, initSettleClaimQueue, connection } from '../index';
import { INSURANCE_ABI } from '../../helpers/insuranceAbi';
import { SettleClaimJobData } from '../types';
import { safeSend } from '../../helpers/safeSend';
import { sendOnFail } from '../../helpers/alerts';
import { WalletManager, WalletRole } from '../../helpers/walletManager';

const LOCK_DURATION_MS = 180_000; // 3 min

// Settles one approved insurance claim per job once its payout delay has
// elapsed. concurrency:1 on a DEDICATED Settle wallet means:
//   - claims are settled strictly ONE BY ONE (serialized), and
//   - the Settle wallet's nonce sequence is never touched by any other worker,
//     so there is no cross-worker nonce contention.
// safeSend runs a presim staticCall first, so a claim that is not-yet-due,
// already settled, or one this wallet isn't authorised to settle reverts in
// simulation at ZERO gas and returns false — no wasted gas, no retry loop.
export function startSettleClaimWorker(config: ExecutorConfig, walletManager: WalletManager) {
    if (!config.insuranceDiamondAddress) {
        logger.info('settle-claim-worker: INSURANCE_DIAMOND_ADDRESS unset — insurance settlement keeper disabled');
        return;
    }

    const signer = walletManager.getSigner(WalletRole.Settle);
    const insurance = new Contract(config.insuranceDiamondAddress, INSURANCE_ABI, signer);

    initSettleClaimQueue();

    const worker = new Worker<SettleClaimJobData>(
        SETTLE_CLAIM_QUEUE_NAME,
        async (job) => {
            const { claimId } = job.data;
            if (!claimId) {
                const msg = `settle-claim-worker: missing claimId jobId= ${job.id}`;
                logger.error(msg);
                await sendOnFail(config, msg);
                return;
            }

            logger.info(`▶️ settle-claim-worker: job start claimId= ${claimId} jobId= ${job.id}`);

            try {
                // presim on (default): stale / not-yet-due / unauthorised claims
                // revert in simulation at 0 gas → safeSend returns false, we log,
                // no retry, no wasted gas.
                const ok = await safeSend(
                    insurance,
                    'settleClaim',
                    [claimId],
                    config,
                    { claimId },
                );

                if (!ok) {
                    logger.warn(`settle-claim-worker: settle skipped/failed claimId= ${claimId} jobId= ${job.id} (safeSend already alerted)`);
                } else {
                    logger.info(`✅ settle-claim-worker: settled claimId= ${claimId} jobId= ${job.id}`);
                }
            } catch (err: any) {
                const reason = err?.stack ?? err?.message ?? String(err);
                logger.error(`settle-claim-worker error claimId= ${claimId} jobId= ${job.id}: ${reason}`);
                // Only alert if safeSend hasn't already — avoids duplicate Discord noise
                if (!(err as any)._alerted) {
                    await sendOnFail(config, `Settle-claim worker error\nClaimId= ${claimId}\nJobId= ${job.id}\n↳ ${err?.message ?? String(err)}`);
                }
                throw err; // transient (nonce/network) → BullMQ retries
            }
        },
        {
            connection,
            concurrency: 1,
            lockDuration: LOCK_DURATION_MS,
        },
    );

    worker.on('error', (err) => logger.error(`❌ settle-claim-worker: worker error: ${err?.message}`));
    worker.on('completed', (job) => logger.info(`✅ settle-claim-worker: completed jobId= ${job.id} claimId= ${job.data?.claimId}`));
    worker.on('failed', (job, err) => logger.warn(`❌ settle-claim-worker: failed jobId= ${job?.id} claimId= ${job?.data?.claimId}: ${err?.message}`));

    logger.info('▶️ settle-claim-worker: started');
}
