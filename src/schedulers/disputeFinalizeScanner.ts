import { initDisputeFinalizeScannerQueue } from '../queue';
import { logger } from '../helpers/logger';

// Tick for the dispute finalize scanner (see queue/workers/finalizeDispute.ts).
// Each tick folds new DisputeDecided logs into the pending set and schedules a
// finalize job at each deadline, so the interval only bounds how soon a new
// decision is noticed — against a 24h appeal window — not how late a due one is
// finalized. Interval: DISPUTE_FINALIZE_SCAN_INTERVAL_MIN, default 5. A one-shot
// run at startup catches up immediately on a fresh deploy.
export async function startDisputeFinalizeScannerSchedule() {
    const queue = initDisputeFinalizeScannerQueue();
    const min = Number(process.env.DISPUTE_FINALIZE_SCAN_INTERVAL_MIN ?? '5');
    const intervalMin = Number.isInteger(min) && min >= 1 ? min : 5;
    const everyMs = intervalMin * 60 * 1000;

    // BullMQ's repeat key embeds `every`, so a changed interval would add a
    // second schedule; drop any that doesn't match (see settleClaimScanner.ts).
    for (const r of await queue.getRepeatableJobs()) {
        if (r.name === 'DisputeFinalizeScan' && String(r.every) !== String(everyMs)) {
            await queue.removeRepeatableByKey(r.key);
            logger.info(`dispute-finalize-scanner: removed stale repeat schedule every=${r.every}ms`);
        }
    }

    await queue.add('DisputeFinalizeScan', {}, { jobId: 'dispute-finalize-scanner', repeat: { every: everyMs } });
    await queue.add('DisputeFinalizeScanStartup', {}, { jobId: 'dispute-finalize-scanner-startup' });
    logger.info(`dispute-finalize-scanner: scheduled every ${intervalMin} min`);
}
