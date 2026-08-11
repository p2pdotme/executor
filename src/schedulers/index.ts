import { startOrderSweeperSchedule } from './orderSweeper';
import { startOrderScannerSchedule } from './orderScanner';
import { startDailyKeeperSchedule } from './dailyKeeper';
import { startCircleRefreshSchedule } from './circleRefresh';

export async function startSchedulers() {
    await startOrderSweeperSchedule();
    await startOrderScannerSchedule();
    await startDailyKeeperSchedule();
    await startCircleRefreshSchedule();
}
