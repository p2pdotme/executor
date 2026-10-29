import { initPrizerailPayoutScannerQueue } from '../queue/prizerailQueues';
import { ExecutorConfig } from '../helpers/config';
import { logger } from '../helpers/logger';
import { PRIZERAIL_POLICY } from '../prizerail/config';

const SCAN_JOB_NAME = 'PrizerailPayoutScan';
const STARTUP_JOB_NAME = 'PrizerailPayoutScanStartup';

// Periodic winner discovery for the Prizerail programme. Gated exactly like
// its worker so a deploy without the scan never promotes jobs nobody consumes.
export async function startPrizerailPayoutScannerSchedule(config: ExecutorConfig): Promise<void> {
    const prizerail = config.prizerail;
    if (!prizerail) {
        logger.info('prizerail-payout-scan: PRIZERAIL_API_KEY unset — schedule not registered');
        return;
    }

    const queue = initPrizerailPayoutScannerQueue();
    const everyMs = PRIZERAIL_POLICY.payoutScanIntervalMin * 60 * 1000;

    // BullMQ's repeat key embeds `every`; drop any schedule for a different
    // interval or both fire forever (see settleClaimScanner).
    for (const r of await queue.getRepeatableJobs()) {
        if (r.name === SCAN_JOB_NAME && String(r.every) !== String(everyMs)) {
            await queue.removeRepeatableByKey(r.key);
            logger.info(`prizerail-payout-scan: removed stale repeat schedule every=${r.every}ms`);
        }
    }

    await queue.add(SCAN_JOB_NAME, {}, { jobId: 'prizerail-payout-scanner', repeat: { every: everyMs } });
    await queue.add(STARTUP_JOB_NAME, {}, { jobId: 'prizerail-payout-scanner-startup' });
    logger.info(`prizerail-payout-scan: scheduled every ${PRIZERAIL_POLICY.payoutScanIntervalMin} min`);
}
