import { Worker } from 'bullmq';
import { ExecutorConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import {
    SETTLE_CLAIM_SCANNER_QUEUE_NAME,
    initSettleClaimScannerQueue,
    addSettleClaimJob,
    connection,
} from '../index';

const LOCK_DURATION_MS = 180_000; // 3 min
const PAGE = 500;
const MAX_GQL_RETRIES = 6;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function gql<T>(url: string, query: string, variables: Record<string, unknown>): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_GQL_RETRIES; attempt++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query, variables }),
            });
            if (res.status === 429 || res.status >= 500) {
                throw new Error(`subgraph ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
            }
            if (!res.ok) throw new Error(`subgraph ${res.status}: ${await res.text()}`);
            const json = (await res.json()) as { data?: T; errors?: unknown };
            if (json.errors) throw new Error(`subgraph errors: ${JSON.stringify(json.errors)}`);
            if (!json.data) throw new Error('subgraph: empty data');
            return json.data;
        } catch (err: any) {
            lastErr = err;
            if (String(err?.message ?? err).startsWith('subgraph errors:')) throw err;
            const backoff = Math.min(15000, 500 * 2 ** (attempt - 1));
            logger.warn(`settle-scanner: gql attempt ${attempt}/${MAX_GQL_RETRIES} failed, retry in ${backoff}ms`);
            await sleep(backoff);
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// APPROVED (status=2) claims whose payout delay has already elapsed. status
// filters out SETTLED/REJECTED/WITHDRAWN, so a claim only surfaces here while it
// genuinely still needs settling — once settled the subgraph flips it to
// status=4 and it drops out on the next tick.
const PENDING_CLAIMS_QUERY = `
  query PendingClaims($now: BigInt!, $first: Int!, $skip: Int!) {
    insuranceClaims(
      first: $first
      skip: $skip
      where: { status: 2, payoutEligibleAt_lte: $now }
      orderBy: payoutEligibleAt
      orderDirection: asc
    ) {
      claimId
      payoutEligibleAt
    }
  }
`;

async function fetchDueClaims(url: string, nowSec: number): Promise<string[]> {
    const ids: string[] = [];
    for (let skip = 0; ; skip += PAGE) {
        const { insuranceClaims } = await gql<{ insuranceClaims: { claimId: string }[] }>(
            url,
            PENDING_CLAIMS_QUERY,
            { now: String(nowSec), first: PAGE, skip },
        );
        for (const c of insuranceClaims) ids.push(String(c.claimId));
        if (insuranceClaims.length < PAGE) break;
    }
    return ids;
}

// Reconciliation safety net for the ClaimApproved WS listener: enqueues any
// approved-and-overdue claim into the settle queue. Enqueue is idempotent
// (jobId=settle-<claimId>): a claim already scheduled by the WS listener or
// still in-flight is deduped, so this can run as often as we like without
// double-settling. The actual settleClaim tx (and its presim gating) happens in
// settleClaimWorker — this worker only enqueues.
export function startSettleClaimScannerWorker(config: ExecutorConfig) {
    if (!config.insuranceDiamondAddress) {
        logger.info('settle-scanner: INSURANCE_DIAMOND_ADDRESS unset — reconciliation scanner disabled');
        return;
    }

    initSettleClaimScannerQueue();

    const worker = new Worker(
        SETTLE_CLAIM_SCANNER_QUEUE_NAME,
        async (_job) => {
            if (!config.subgraphUrl) {
                logger.warn('settle-scanner: SUBGRAPH_URL unset — skipping reconciliation tick');
                return;
            }

            logger.info('settle-scanner: starting reconciliation tick');
            const nowSec = Math.floor(Date.now() / 1000);
            const due = await fetchDueClaims(config.subgraphUrl, nowSec);

            if (due.length === 0) {
                logger.info('settle-scanner: no overdue approved claims');
                return;
            }

            logger.info(`settle-scanner: ${due.length} overdue approved claim(s) — enqueueing`);
            for (const claimId of due) {
                await addSettleClaimJob({ claimId }, { jobId: `settle-${claimId}`, delayMs: 0 });
            }
            logger.info('settle-scanner: reconciliation tick completed');
        },
        {
            connection,
            concurrency: 1,
            lockDuration: LOCK_DURATION_MS,
        },
    );

    worker.on('error', (err) => logger.error(`settle-scanner: worker error: ${err?.message}`));
    worker.on('completed', (job) => logger.info(`settle-scanner: completed jobId=${job.id} ${job.name}`));
    worker.on('failed', (job, err) => logger.warn(`settle-scanner: failed jobId=${job?.id} ${job?.name}: ${err?.message}`));

    logger.info('settle-scanner: started');
}
