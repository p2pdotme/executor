import { initOrderSweeperQueue } from '../queue';

export async function startOrderSweeperSchedule() {
    const queue = initOrderSweeperQueue();
    const every1m = 60 * 1000;

    await queue.add(
        'OrderSweep',
        {},
        {
            jobId: 'order-sweeper',
            repeat: { every: every1m },
        },
    );
}
