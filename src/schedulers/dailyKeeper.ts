import { Job } from 'bullmq';
import { initDailyKeeperQueue } from '../queue';
import { logger } from '../helpers/logger';

const STARTUP_JOB_ID = 'daily-keeper-startup';

// Runs the permissionless keeper (approveUnstakeBatch + blacklistInactiveMerchants)
// on a fixed interval, configurable via DAILY_KEEPER_INTERVAL_HOURS (default 3).
//
// Was a once-a-day cron at DAILY_KEEPER_CRON_HOUR (now unused). Moved to a 3h
// interval so an unstake request is approved within hours instead of waiting up
// to a full day for the next tick. Both calls are idempotent and re-validate
// everything on-chain, and each is skipped when the subgraph reports no
// candidates — so a tighter interval mostly costs reads, not gas.
export async function startDailyKeeperSchedule() {
    const queue = initDailyKeeperQueue();
    const hours = Number(process.env.DAILY_KEEPER_INTERVAL_HOURS ?? '3');
    const intervalHours = Number.isInteger(hours) && hours >= 1 && hours <= 24 ? hours : 3;
    const everyMs = intervalHours * 60 * 60 * 1000;

    // BullMQ's repeat key embeds the schedule itself (`repeat.js`: suffix =
    // pattern ? pattern : String(every)), so a schedule registered under a
    // DIFFERENT key is never replaced — it keeps firing alongside the new one
    // forever. Two cases to clear: the old `0 <hour> * * *` cron from before
    // this became an interval, and any earlier DAILY_KEEPER_INTERVAL_HOURS.
    for (const r of await queue.getRepeatableJobs()) {
        if (r.name === 'DailyKeeper' && String(r.every) !== String(everyMs)) {
            await queue.removeRepeatableByKey(r.key);
            logger.info(
                `daily-keeper: removed stale repeat schedule (pattern=${r.pattern ?? '-'}, every=${r.every ?? '-'})`,
            );
        }
    }

    await queue.add(
        'DailyKeeper',
        {},
        {
            jobId: 'daily-keeper',
            repeat: { every: everyMs },
        },
    );
    logger.info(`daily-keeper: scheduled every ${intervalHours}h`);

    // One-shot run at startup so a fresh deploy validates the full keeper flow
    // end-to-end immediately instead of waiting for the next tick. The job
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
