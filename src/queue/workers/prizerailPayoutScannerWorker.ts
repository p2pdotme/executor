import { Worker } from 'bullmq';
import { ExecutorConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import { sendOnFail } from '../../helpers/alerts';
import { redactError } from '../../helpers/redact';
import { trySendDiscordAlert } from '../../helpers/discord';
import { withTimeout } from '../../helpers/provider';
import { connection } from '../index';
import {
    addPrizerailPayoutJob,
    initPrizerailPayoutScannerQueue,
    PRIZERAIL_PAYOUT_SCANNER_QUEUE_NAME,
} from '../prizerailQueues';
import { PrizerailClient } from '../../prizerail/client';
import { getPrizerailStore } from '../../prizerail/db';
import { planPayout } from '../../prizerail/payout';
import { PRIZERAIL_POLICY } from '../../prizerail/config';
import type { PrizerailStore } from '../../prizerail/store';
import { formatWinnersAlert, planWinnerRecords, splitDiscordMessage, WinnerRecord } from '../../prizerail/winners';
import type { PrizerailDrawing, PrizerailDrawingStatus } from '../../prizerail/types';
import type { PrizerailConfig } from '../../prizerail/config';

const LOCK_DURATION_MS = 180_000;
const JOB_TIMEOUT_MS = 150_000;
const PAGE_LIMIT = 100;
// Hard ceiling per status per tick. Normally the walk stops much earlier: as
// soon as a page holds nothing but drawings already marked done.
const MAX_PAGES_PER_STATUS = 10;
// `settled` drawings are re-read until they flip to `paid`; only then is the
// drawing marked done so later ticks skip it.
const SCAN_STATUSES: readonly PrizerailDrawingStatus[] = ['settled', 'paid'];
const PAYABLE_BATCH = 200;
// 'paying' rows older than this are re-queued so the worker reconciles them
// from the chain (see reconcileInFlight). Nothing else ever re-touches them.
const STALE_PAYING_MS = 5 * 60_000;

type Ctx = { config: ExecutorConfig; prizerail: PrizerailConfig; store: PrizerailStore; client: PrizerailClient };
type Fetched = { drawings: PrizerailDrawing[]; invalid: number };

async function fetchPending(ctx: Ctx, status: PrizerailDrawingStatus): Promise<Fetched> {
    const slug = ctx.prizerail.campaignSlug;
    const drawings: PrizerailDrawing[] = [];
    let invalid = 0;
    let before: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_STATUS; page++) {
        const res = await ctx.client.listDrawings({ status, limit: PAGE_LIMIT, before });
        invalid += res.invalid;
        let pendingOnPage = 0;
        for (const d of res.drawings) {
            if (await ctx.store.isDrawingDone(slug, d.id)) continue;
            pendingOnPage += 1;
            drawings.push(d);
        }
        // Newest first: a page with nothing pending means everything older
        // was handled on an earlier tick.
        if (pendingOnPage === 0 || !res.nextBefore) break;
        before = res.nextBefore;
    }
    return { drawings, invalid };
}

async function alertWinners(ctx: Ctx, drawing: PrizerailDrawing, records: readonly WinnerRecord[]): Promise<boolean> {
    const chunks = splitDiscordMessage(formatWinnersAlert(ctx.prizerail.campaignSlug, drawing, records));
    for (const chunk of chunks) {
        if (!(await trySendDiscordAlert(ctx.config.discordOnSuccessWebhookUrl, chunk))) return false;
    }
    return true;
}

async function processDrawing(ctx: Ctx, drawing: PrizerailDrawing): Promise<void> {
    const slug = ctx.prizerail.campaignSlug;
    const wallets = await ctx.store.resolveEntrants(slug, drawing.winners.map((w) => w.winner));
    const planned = planWinnerRecords(drawing, (id) => wallets[id] ?? null, Date.now());

    const toAlert: WinnerRecord[] = [];
    const toPay: WinnerRecord[] = [];
    let fresh = 0;
    for (const record of planned) {
        const decision = planPayout(record, PRIZERAIL_POLICY.maxAutoPayoutCents);
        const result = await ctx.store.upsertWinner(slug, record, decision);
        if (result.inserted) fresh += 1;
        if (!result.alerted) toAlert.push(record);
        if (result.payoutStatus === 'pending') toPay.push(record);
    }

    if (toAlert.length > 0) {
        logger.info(`prizerail-payout-scan: drawing ${drawing.id} (${drawing.status}) → ${fresh} new, ${toAlert.length} to alert`);
        // Mark alerted only once Discord accepted every chunk; otherwise the
        // next tick re-sends rather than forgetting the winners.
        if (await alertWinners(ctx, drawing, toAlert)) await ctx.store.markAlerted(slug, toAlert);
        const unresolved = toAlert.filter((r) => !r.wallet);
        if (unresolved.length > 0) {
            await sendOnFail(
                ctx.config,
                `Prizerail drawing ${drawing.id}: ${unresolved.length} winner(s) have no wallet in the entrant map — check PRIZERAIL_ENTRANT_HMAC_KEY has not changed`,
            );
        }
    }
    if (ctx.prizerail.payoutEnabled) {
        for (const r of toPay) await addPrizerailPayoutJob({ campaign: slug, drawingId: r.drawingId, position: r.position });
    }
    if (drawing.status === 'paid') await ctx.store.markDrawingDone(slug, drawing.id);
}

// Catch-all: anything still pending in the ledger (a lost job, a released
// claim after an empty prize wallet) is re-queued. Idempotent — the worker
// claims the row before paying and the jobId dedupes in-flight jobs.
async function requeuePayable(ctx: Ctx): Promise<void> {
    if (!ctx.prizerail.payoutEnabled) return;
    const slug = ctx.prizerail.campaignSlug;
    const rows = await ctx.store.listPayable(slug, PAYABLE_BATCH);
    const stale = await ctx.store.listStalePaying(slug, STALE_PAYING_MS, PAYABLE_BATCH);
    for (const r of [...rows, ...stale]) await addPrizerailPayoutJob({ campaign: r.campaign, drawingId: r.drawingId, position: r.position });
    if (rows.length > 0) logger.info(`prizerail-payout-scan: ${rows.length} payable row(s) queued`);
    if (stale.length > 0) logger.warn(`prizerail-payout-scan: ${stale.length} stale 'paying' row(s) re-queued for reconciliation`);
}

async function runTick(ctx: Ctx): Promise<void> {
    const seen = new Set<string>();
    let invalid = 0;
    for (const status of SCAN_STATUSES) {
        const fetched = await fetchPending(ctx, status);
        invalid += fetched.invalid;
        for (const drawing of fetched.drawings) {
            if (seen.has(drawing.id) || drawing.winners.length === 0) continue;
            seen.add(drawing.id);
            await processDrawing(ctx, drawing);
        }
    }
    await requeuePayable(ctx);
    if (invalid > 0) {
        await sendOnFail(ctx.config, `Prizerail scan: ${invalid} drawing(s) skipped as malformed — check the API shape against prizerail/types.ts`);
    }
}

/**
 * Winner discovery for the Prizerail programme. Reads settled and paid
 * drawings, maps each winner's entrant id back to a wallet, ledgers the
 * result in Postgres, posts it to Discord and, when payout is enabled,
 * queues each payable winner for the payout worker.
 */
export function startPrizerailPayoutScannerWorker(config: ExecutorConfig): void {
    const prizerail = config.prizerail;
    if (!prizerail) {
        logger.info('prizerail-payout-scan: PRIZERAIL_API_KEY unset — worker not started');
        return;
    }

    initPrizerailPayoutScannerQueue();
    const ctx: Ctx = {
        config,
        prizerail,
        store: getPrizerailStore(config),
        client: new PrizerailClient({ baseUrl: prizerail.baseUrl, apiKey: prizerail.apiKey, campaignSlug: prizerail.campaignSlug }),
    };

    const worker = new Worker(
        PRIZERAIL_PAYOUT_SCANNER_QUEUE_NAME,
        async () => {
            logger.info('prizerail-payout-scan: tick start');
            await withTimeout(runTick(ctx), JOB_TIMEOUT_MS);
            logger.info('prizerail-payout-scan: tick done');
        },
        { connection, concurrency: 1, lockDuration: LOCK_DURATION_MS },
    );

    worker.on('error', (err) => logger.error(`prizerail-payout-scan: worker error: ${redactError(err)}`));
    worker.on('failed', (job, err) => {
        const msg = `prizerail-payout-scan: failed jobId=${job?.id}: ${redactError(err)}`;
        logger.warn(msg);
        void sendOnFail(config, msg).catch(() => {});
    });

    logger.info(`prizerail-payout-scan: started (campaign=${prizerail.campaignSlug}, payout=${prizerail.payoutEnabled ? 'on' : 'off'})`);
}
