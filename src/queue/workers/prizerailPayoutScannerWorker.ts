import { Worker } from 'bullmq';
import { ExecutorConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import { sendOnFail } from '../../helpers/alerts';
import { trySendDiscordAlert } from '../../helpers/discord';
import { withTimeout } from '../../helpers/provider';
import { connection } from '../index';
import {
    initPrizerailPayoutScannerQueue,
    PRIZERAIL_PAYOUT_SCANNER_QUEUE_NAME,
} from '../prizerailQueues';
import { PrizerailClient } from '../../prizerail/client';
import { resolveEntrants } from '../../prizerail/entrantMap';
import { isDrawingDone, markAlerted, markDrawingDone, upsertWinner } from '../../prizerail/ledger';
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
// drawing marked done so later ticks skip it. The settled list only ever
// holds drawings still waiting on a held prize, so it stays small.
const SCAN_STATUSES: readonly PrizerailDrawingStatus[] = ['settled', 'paid'];

type Fetched = { drawings: PrizerailDrawing[]; invalid: number };

async function fetchPending(client: PrizerailClient, slug: string, status: PrizerailDrawingStatus): Promise<Fetched> {
    const drawings: PrizerailDrawing[] = [];
    let invalid = 0;
    let before: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_STATUS; page++) {
        const res = await client.listDrawings({ status, limit: PAGE_LIMIT, before });
        invalid += res.invalid;
        let pendingOnPage = 0;
        for (const d of res.drawings) {
            if (await isDrawingDone(connection, slug, d.id)) continue;
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

async function alertWinners(
    config: ExecutorConfig,
    slug: string,
    drawing: PrizerailDrawing,
    records: readonly WinnerRecord[],
): Promise<boolean> {
    const chunks = splitDiscordMessage(formatWinnersAlert(slug, drawing, records));
    for (const chunk of chunks) {
        if (!(await trySendDiscordAlert(config.discordOnSuccessWebhookUrl, chunk))) return false;
    }
    return true;
}

async function processDrawing(config: ExecutorConfig, prizerail: PrizerailConfig, drawing: PrizerailDrawing): Promise<void> {
    const slug = prizerail.campaignSlug;
    const wallets = await resolveEntrants(connection, slug, drawing.winners.map((w) => w.winner));
    const planned = planWinnerRecords(drawing, (id) => wallets[id] ?? null, Date.now());

    const toAlert: WinnerRecord[] = [];
    let fresh = 0;
    for (const record of planned) {
        const result = await upsertWinner(connection, slug, record);
        if (result.fresh) fresh += 1;
        if (!result.alerted) toAlert.push(result.record);
    }

    if (toAlert.length > 0) {
        logger.info(`prizerail-payout-scan: drawing ${drawing.id} (${drawing.status}) → ${fresh} new, ${toAlert.length} to alert`);
        // Mark alerted only once Discord accepted every chunk; otherwise the
        // next tick re-sends rather than forgetting the winners.
        if (await alertWinners(config, slug, drawing, toAlert)) {
            await markAlerted(connection, slug, toAlert);
        }
        const unresolved = toAlert.filter((r) => !r.wallet);
        if (unresolved.length > 0) {
            await sendOnFail(
                config,
                `Prizerail drawing ${drawing.id}: ${unresolved.length} winner(s) have no wallet in the entrant map — check PRIZERAIL_ENTRANT_HMAC_KEY has not changed`,
            );
        }
    }
    if (drawing.status === 'paid') await markDrawingDone(connection, slug, drawing.id);
}

async function runTick(config: ExecutorConfig, prizerail: PrizerailConfig, client: PrizerailClient): Promise<void> {
    const slug = prizerail.campaignSlug;
    const seen = new Set<string>();
    let invalid = 0;
    for (const status of SCAN_STATUSES) {
        const fetched = await fetchPending(client, slug, status);
        invalid += fetched.invalid;
        for (const drawing of fetched.drawings) {
            if (seen.has(drawing.id) || drawing.winners.length === 0) continue;
            seen.add(drawing.id);
            await processDrawing(config, prizerail, drawing);
        }
    }
    if (invalid > 0) {
        await sendOnFail(config, `Prizerail scan: ${invalid} drawing(s) skipped as malformed — check the API shape against prizerail/types.ts`);
    }
}

/**
 * Winner discovery for the Prizerail programme. Reads settled and paid
 * drawings, maps each winner's entrant id back to a wallet, ledgers the
 * result in Redis and posts it to Discord. It sends NO funds: Prizerail pays
 * the campaign wallet, and paying users on from there is a manual step until
 * the payout rail is decided and enabled.
 */
export function startPrizerailPayoutScannerWorker(config: ExecutorConfig): void {
    const prizerail = config.prizerail;
    if (!prizerail || !prizerail.payoutScanEnabled) {
        logger.info('prizerail-payout-scan: disabled (PRIZERAIL_PAYOUT_SCAN_ENABLED != true) — worker not started');
        return;
    }

    initPrizerailPayoutScannerQueue();
    const client = new PrizerailClient({
        baseUrl: prizerail.baseUrl,
        apiKey: prizerail.apiKey,
        campaignSlug: prizerail.campaignSlug,
    });

    const worker = new Worker(
        PRIZERAIL_PAYOUT_SCANNER_QUEUE_NAME,
        async () => {
            logger.info('prizerail-payout-scan: tick start');
            await withTimeout(runTick(config, prizerail, client), JOB_TIMEOUT_MS);
            logger.info('prizerail-payout-scan: tick done');
        },
        { connection, concurrency: 1, lockDuration: LOCK_DURATION_MS },
    );

    worker.on('error', (err) => logger.error(`prizerail-payout-scan: worker error: ${err?.message}`));
    worker.on('failed', (job, err) => {
        const msg = `prizerail-payout-scan: failed jobId=${job?.id}: ${err?.message}`;
        logger.warn(msg);
        void sendOnFail(config, msg).catch(() => {});
    });

    logger.info(`prizerail-payout-scan: started (campaign=${prizerail.campaignSlug})`);
}
