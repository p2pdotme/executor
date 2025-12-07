import { initOrderScannerQueue } from '../queue';

export async function startOrderScannerSchedule() {
    const queue = initOrderScannerQueue();
    const every1h = 60 * 60 * 1000;

    await queue.add(
        'OrderScan',
        {},
        {
            jobId: 'order-scanner',
            repeat: { every: every1h },
        },
    );
}
