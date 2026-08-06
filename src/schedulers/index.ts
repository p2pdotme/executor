import { startOrderSweeperSchedule } from './orderSweeper';
import { startOrderScannerSchedule } from './orderScanner';
import { startDailyKeeperSchedule } from './dailyKeeper';
import { startSettleClaimScannerSchedule } from './settleClaimScanner';

export async function startSchedulers() {
    await startOrderSweeperSchedule();
    await startOrderScannerSchedule();
    await startDailyKeeperSchedule();
    await startSettleClaimScannerSchedule();
}
