import { initSettleClaimScannerQueue } from '../queue';

// Reconciliation tick for the insurance settlement keeper — enqueues any
// approved-and-overdue claim (missed WS events, approvals before boot, delayed
// jobs lost on a Redis flush) into the settle queue. Interval configurable via
// SETTLE_SCANNER_INTERVAL_MIN (default 15 min). Enqueue is idempotent so a
// tighter interval is safe. A one-shot run at startup reconciles immediately on
// a fresh deploy instead of waiting for the first interval.
export async function startSettleClaimScannerSchedule() {
    const queue = initSettleClaimScannerQueue();
    const min = Number(process.env.SETTLE_SCANNER_INTERVAL_MIN ?? '15');
    const intervalMin = Number.isFinite(min) && min >= 1 ? min : 15;

    await queue.add(
        'SettleClaimScan',
        {},
        {
            jobId: 'settle-claim-scanner',
            repeat: { every: intervalMin * 60 * 1000 },
        },
    );

    await queue.add('SettleClaimScanStartup', {}, { jobId: 'settle-claim-scanner-startup' });
}
