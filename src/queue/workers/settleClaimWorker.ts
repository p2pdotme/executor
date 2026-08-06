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
// elapsed, using the shared Keeper wallet (same one that signs the daily
// approveUnstakeBatch + blacklistInactiveMerchants). concurrency:1 settles
// claims strictly ONE BY ONE. Nonce safety: getSigner returns the single shared
// NonceManager for the Keeper wallet, which hands out sequential nonces
// atomically — so even if a settle overlaps the once-a-day keeper run, the two
// never collide on a nonce. Calls the permissionless settleClaim, so the Keeper
// wallet needs NO on-chain whitelist — just ETH for gas.
// We presim here rather than letting safeSend do it, because safeSend alerts
// Discord on EVERY presim revert. The reconciliation scanner re-enqueues an
// unsettleable claim every tick forever, so that would be a permanent alert
// loop. Instead: a reverting claim costs 0 gas, is logged, and pings Discord
// only the FIRST time we see it fail (alertedClaims below).
export function startSettleClaimWorker(config: ExecutorConfig, walletManager: WalletManager) {
    if (!config.insuranceDiamondAddress) {
        logger.info('settle-claim-worker: INSURANCE_DIAMOND_ADDRESS unset — insurance settlement keeper disabled');
        return;
    }

    const signer = walletManager.getSigner(WalletRole.Keeper);
    const insurance = new Contract(config.insuranceDiamondAddress, INSURANCE_ABI, signer);

    // claimIds we've already reported as unsettleable, so the 15-min scanner
    // doesn't turn one stuck claim into a permanent Discord alert loop. Cleared
    // on restart, which is the right cadence for a re-reminder.
    const alertedClaims = new Set<string>();

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
                // Presim ourselves so a permanently-unsettleable claim doesn't
                // alert on every scanner tick. Stale / not-yet-due / already
                // settled claims revert here at 0 gas.
                try {
                    await (insurance as any).settleClaim.staticCall(claimId);
                } catch (simErr: any) {
                    const reason = simErr?.shortMessage ?? simErr?.message ?? String(simErr);
                    logger.warn(`settle-claim-worker: presim reverted claimId= ${claimId} — skipping: ${reason}`);
                    if (!alertedClaims.has(claimId)) {
                        alertedClaims.add(claimId);
                        await sendOnFail(
                            config,
                            `settleClaim | staticCall reverted | claimId=${claimId}\n↳ ${reason}\n↳ further failures for this claim are suppressed until restart`,
                        );
                    }
                    return;
                }
                alertedClaims.delete(claimId);

                // skipPresim=true: we just simulated this exact call above.
                const ok = await safeSend(
                    insurance,
                    'settleClaim',
                    [claimId],
                    config,
                    { claimId },
                    true,
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
