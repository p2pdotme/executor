import { Job } from 'bullmq';
import { Contract } from 'ethers';
import { ExecutorConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import { INSURANCE_ABI } from '../../helpers/insuranceAbi';
import { SettleClaimJobData } from '../types';
import { safeSend } from '../../helpers/safeSend';
import { sendOnFail } from '../../helpers/alerts';
import { WalletManager, WalletRole } from '../../helpers/walletManager';

export type SettleClaimHandler = (job: Job<SettleClaimJobData>) => Promise<void>;

// Settles one approved insurance claim per job once its payout delay has
// elapsed. Calls the permissionless settleClaim, so the Keeper wallet needs NO
// on-chain whitelist — just ETH for gas.
//
// This is a HANDLER, not a Worker: settle jobs ride the daily-keeper queue and
// are executed by that queue's single concurrency:1 worker. That is deliberate
// and load-bearing. Both the daily run (approveUnstakeBatch,
// blacklistInactiveMerchants) and settleClaim sign with the SAME Keeper wallet,
// and safeSend calls signer.reset() on NONCE_EXPIRED / REPLACEMENT_UNDERPRICED /
// TX_WAIT_TIMEOUT. reset() clears the delta on the SHARED NonceManager, so a
// settle timing out while the daily run is mid-`approveUnstakeBatch` chunk loop
// would corrupt that run's nonce accounting. One queue + one worker means the
// Keeper wallet has exactly ONE consumer and the two can never overlap.
//
// We presim here rather than letting safeSend do it, because safeSend alerts
// Discord on EVERY presim revert. The reconciliation scanner re-enqueues an
// unsettleable claim every tick forever, so that would be a permanent alert
// loop. Instead: a reverting claim costs 0 gas, is logged, and pings Discord
// only the FIRST time we see it fail (alertedClaims below).
//
// Returns null when INSURANCE_DIAMOND_ADDRESS is unset — the insurance keeper is
// then disabled end to end and nothing enqueues settle jobs in the first place.
export function createSettleClaimHandler(
    config: ExecutorConfig,
    walletManager: WalletManager,
): SettleClaimHandler | null {
    if (!config.insuranceDiamondAddress) {
        logger.info('settle-claim: INSURANCE_DIAMOND_ADDRESS unset — insurance settlement keeper disabled');
        return null;
    }

    const signer = walletManager.getSigner(WalletRole.Keeper);
    const insurance = new Contract(config.insuranceDiamondAddress, INSURANCE_ABI, signer);

    // claimIds we've already reported as unsettleable, so the 15-min scanner
    // doesn't turn one stuck claim into a permanent Discord alert loop. Cleared
    // on restart, which is the right cadence for a re-reminder.
    const alertedClaims = new Set<string>();

    logger.info('settle-claim: handler registered on the daily-keeper queue');

    return async function settleClaim(job) {
        const { claimId } = job.data;
        if (!claimId) {
            const msg = `settle-claim: missing claimId jobId= ${job.id}`;
            logger.error(msg);
            await sendOnFail(config, msg);
            return;
        }

        logger.info(`▶️ settle-claim: job start claimId= ${claimId} jobId= ${job.id}`);

        try {
            // Presim ourselves so a permanently-unsettleable claim doesn't
            // alert on every scanner tick. Stale / not-yet-due / already
            // settled claims revert here at 0 gas.
            try {
                await (insurance as any).settleClaim.staticCall(claimId);
            } catch (simErr: any) {
                const reason = simErr?.shortMessage ?? simErr?.message ?? String(simErr);
                logger.warn(`settle-claim: presim reverted claimId= ${claimId} — skipping: ${reason}`);
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
                logger.warn(`settle-claim: settle skipped/failed claimId= ${claimId} jobId= ${job.id} (safeSend already alerted)`);
            } else {
                logger.info(`✅ settle-claim: settled claimId= ${claimId} jobId= ${job.id}`);
            }
        } catch (err: any) {
            const reason = err?.stack ?? err?.message ?? String(err);
            logger.error(`settle-claim error claimId= ${claimId} jobId= ${job.id}: ${reason}`);
            // Only alert if safeSend hasn't already — avoids duplicate Discord noise
            if (!(err as any)._alerted) {
                await sendOnFail(config, `Settle-claim error\nClaimId= ${claimId}\nJobId= ${job.id}\n↳ ${err?.message ?? String(err)}`);
            }
            throw err; // transient (nonce/network) → BullMQ retries
        }
    };
}
