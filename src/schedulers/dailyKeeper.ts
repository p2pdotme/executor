import { initDailyKeeperQueue } from '../queue';

// Runs the permissionless keeper (approveUnstakeBatch + blacklistInactiveMerchants)
// once per day. Cron hour is configurable via DAILY_KEEPER_CRON_HOUR (UTC, default 3).
export async function startDailyKeeperSchedule() {
    const queue = initDailyKeeperQueue();
    const hour = Number(process.env.DAILY_KEEPER_CRON_HOUR ?? '3');
    const cronHour = Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 3;

    await queue.add(
        'DailyKeeper',
        {},
        {
            jobId: 'daily-keeper',
            repeat: { pattern: `0 ${cronHour} * * *`, tz: 'UTC' },
        },
    );

    // One-shot run at startup so a fresh deploy validates the full keeper flow
    // end-to-end immediately instead of waiting for the next cron tick. The job
    // is idempotent (re-validates everything on-chain) and no-ops cleanly behind
    // the capability gate until V26 is deployed. A fixed jobId + removeOnComplete
    // means rapid redeploys won't stack duplicate startup runs.
    await queue.add('DailyKeeperStartup', {}, { jobId: 'daily-keeper-startup' });
}
