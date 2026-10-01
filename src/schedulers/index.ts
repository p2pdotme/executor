import { startOrderSweeperSchedule } from './orderSweeper';
import { startOrderScannerSchedule } from './orderScanner';
import { startDailyKeeperSchedule } from './dailyKeeper';
import { startCircleRefreshSchedule } from './circleRefresh';
import { startSettleClaimScannerSchedule } from './settleClaimScanner';
import { ExecutorConfig } from '../helpers/config';

export async function startSchedulers(config: ExecutorConfig) {
    await startOrderSweeperSchedule();
    await startOrderScannerSchedule();
    await startDailyKeeperSchedule();
    await startCircleRefreshSchedule();
    await startSettleClaimScannerSchedule(config);
}
