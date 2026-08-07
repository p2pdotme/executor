import { Job } from 'bullmq';
import { initDailyKeeperQueue } from '../queue';
import { logger } from '../helpers/logger';

const STARTUP_JOB_ID = 'daily-keeper-startup';

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
    //
    // Evict a retained failure first: BullMQ's jobId dedupe matches the job hash
    // in ANY state, so a `daily-keeper-startup` left in `failed` (which is what
    // the old removeOnFail:{count:100} produced) silently swallows this add on
    // every subsequent restart and disables the startup run permanently. The
    // queue now sets removeOnFail:true, but that only helps jobs that fail from
    // here on — this clears one already stuck in Redis.
    const stale = await Job.fromId(queue, STARTUP_JOB_ID);
    if (stale && (await stale.getState()) === 'failed') {
        await stale.remove();
        logger.warn(`daily-keeper: removed a retained failed ${STARTUP_JOB_ID} job that was blocking the startup run`);
    }
    await queue.add('DailyKeeperStartup', {}, { jobId: STARTUP_JOB_ID });
}
