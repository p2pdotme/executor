import { startToggleSchedule } from './toggleSchedule';
import { startOrderSweeperSchedule } from './orderSweeper';
import { startOrderScannerSchedule } from './orderScanner';

export async function startSchedulers() {
    await startToggleSchedule();
    await startOrderSweeperSchedule();
    await startOrderScannerSchedule();
}
