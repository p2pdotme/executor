import { initSettleClaimScannerQueue } from '../queue';
import { ExecutorConfig } from '../helpers/config';
import { logger } from '../helpers/logger';

// Reconciliation tick for the insurance settlement keeper — enqueues any
// approved-and-overdue claim (missed WS events, approvals before boot, delayed
// jobs lost on a Redis flush) into the settle queue. Interval configurable via
// SETTLE_SCANNER_INTERVAL_MIN (default 15 min). Enqueue is idempotent so a
// tighter interval is safe. A one-shot run at startup reconciles immediately on
// a fresh deploy instead of waiting for the first interval.
export async function startSettleClaimScannerSchedule(config: ExecutorConfig) {
    // Must be gated like the listener and both workers, otherwise a deploy
    // without insurance keeps promoting scan jobs onto a queue nobody consumes
    // and the waiting list grows forever.
    if (!config.insuranceDiamondAddress) {
        logger.info('settle-scanner: INSURANCE_DIAMOND_ADDRESS unset — reconciliation schedule not registered');
        return;
    }

    const queue = initSettleClaimScannerQueue();
    const min = Number(process.env.SETTLE_SCANNER_INTERVAL_MIN ?? '15');
    const intervalMin = Number.isInteger(min) && min >= 1 ? min : 15;
    const everyMs = intervalMin * 60 * 1000;

    // BullMQ's repeat key embeds `every`, so changing SETTLE_SCANNER_INTERVAL_MIN
    // adds a SECOND schedule instead of replacing the old one and both then fire
    // forever. Drop any schedule that doesn't match the current interval.
    for (const r of await queue.getRepeatableJobs()) {
        if (r.name === 'SettleClaimScan' && String(r.every) !== String(everyMs)) {
            await queue.removeRepeatableByKey(r.key);
            logger.info(`settle-scanner: removed stale repeat schedule every=${r.every}ms`);
        }
    }

    await queue.add(
        'SettleClaimScan',
        {},
        {
            jobId: 'settle-claim-scanner',
            repeat: { every: everyMs },
        },
    );

    await queue.add('SettleClaimScanStartup', {}, { jobId: 'settle-claim-scanner-startup' });
}
