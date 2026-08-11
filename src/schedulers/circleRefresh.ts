import { initCircleRefreshQueue } from '../queue';

export async function startCircleRefreshSchedule() {
    const queue = initCircleRefreshQueue();
    const every1h = 60 * 60 * 1000;

    await queue.add(
        'CircleRefresh',
        {},
        {
            jobId: 'circle-refresh',
            repeat: { every: every1h },
        },
    );

    // One-shot at boot so the cache is populated before the first tick — a
    // fresh deploy would otherwise have no fallback copy for a whole hour.
    await queue.add('CircleRefreshStartup', {}, { jobId: 'circle-refresh-startup' });
}
