import { Worker } from 'bullmq';
import { Contract, getAddress, ZeroAddress } from 'ethers';
import { ExecutorConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import { DAILY_KEEPER_QUEUE_NAME, initDailyKeeperQueue, connection } from '../index';
import { DIAMOND_ABI } from '../../helpers/abi';
import { safeSend } from '../../helpers/safeSend';
import { sendOnFail, sendOnSuccess } from '../../helpers/alerts';
import { WalletManager, WalletRole } from '../../helpers/walletManager';

// Subgraph fan-out (one orders query per active merchant) plus the on-chain
// read validation can take a while, so give the daily job a long lock.
const LOCK_DURATION_MS = 30 * 60_000; // 30 min
const SECS_PER_DAY = 86_400;
const MERCHANT_INACTIVITY_PERIOD = 30 * SECS_PER_DAY; // mirrors the on-chain const
// On-chain currency codes (NOTE: "MEX"/"VEN", not MXN/VES).
const CURRENCIES = ['INR', 'BRL', 'ARS', 'VEN', 'IDR', 'NGN', 'COP', 'MEX', 'USD', 'EUR', 'ECU', 'PEN'];
const PAGE = 500; // subgraph page size
const TX_CHUNK = 50; // merchants per on-chain tx
const READ_CHUNK = 20; // concurrent view-call / subgraph fan-out

// ───────────────────────────── subgraph helpers ─────────────────────────────

function ccyToBytes32(s: string): string {
    const hex = Buffer.from(s, 'utf8').toString('hex');
    if (hex.length > 64) throw new Error(`currency too long: ${s}`);
    return '0x' + hex.padEnd(64, '0');
}

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
            logger.warn(`daily-keeper: gql attempt ${attempt}/${MAX_GQL_RETRIES} failed, retry in ${backoff}ms`);
            await sleep(backoff);
        }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// Merchants flagged as having a pending unstake request, across all currencies.
// Blacklisted merchants are INCLUDED: the diamond now allows approveUnstake for a
// blacklisted merchant (funds always go to the merchant), so a merchant that was
// auto-blacklisted while mid-unstake can still be approved here once cooldown elapses.
const UNSTAKE_REQUESTED_QUERY = `
  query UR($first: Int!, $skip: Int!) {
    circleMerchants(
      first: $first
      skip: $skip
      where: { isUnstakeRequested: true }
      orderBy: startedAt
      orderDirection: asc
    ) {
      merchant
    }
  }
`;

// Registered, non-blacklisted merchants for a single currency.
// startedAt is fetched so recently-joined merchants can be excluded before any
// blacklist proposal (a re-onboarded address could otherwise be flagged on a
// stale prior-life order).
//
// isUnstakeRequested:false is REQUIRED: a merchant with a pending unstake request
// is already out of active liquidity (eligibleForCount needs !unstakeRequested),
// so blacklisting them gains nothing — and it's actively harmful, because once
// blacklisted their unstake can no longer be auto-approved (approveUnstake reverts
// on blacklisted) nor self-finalized (finalizeUnstake is whitelist-gated), trapping
// their stake. Excluding them here lets job1 approve the unstake once cooldown elapses.
const ACTIVE_MERCHANTS_QUERY = `
  query AM($currency: Bytes!, $first: Int!, $skip: Int!) {
    circleMerchants(
      first: $first
      skip: $skip
      where: { currency: $currency, isBlacklisted: false, isUnstakeRequested: false }
      orderBy: startedAt
      orderDirection: asc
    ) {
      merchant
      startedAt
    }
  }
`;

// Most-recent accepted order timestamp for a merchant in a currency.
const LAST_ACCEPTED_QUERY = `
  query LA($addr: Bytes!, $currency: Bytes!) {
    orders_collection(
      first: 1
      where: { currency: $currency, acceptedMerchantAddress: $addr, acceptedAt_gt: "0" }
      orderBy: acceptedAt
      orderDirection: desc
    ) {
      acceptedAt
    }
  }
`;

async function fetchUnstakeRequestedMerchants(url: string): Promise<string[]> {
    const set = new Set<string>();
    for (let skip = 0; ; skip += PAGE) {
        const { circleMerchants } = await gql<{ circleMerchants: { merchant: string }[] }>(
            url,
            UNSTAKE_REQUESTED_QUERY,
            { first: PAGE, skip },
        );
        for (const r of circleMerchants) set.add(getAddress(r.merchant));
        if (circleMerchants.length < PAGE) break;
    }
    return [...set];
}

async function fetchActiveMerchants(
    url: string,
    currencyBytes32: string,
): Promise<{ addr: string; startedAt: number }[]> {
    const byAddr = new Map<string, number>();
    for (let skip = 0; ; skip += PAGE) {
        const { circleMerchants } = await gql<{
            circleMerchants: { merchant: string; startedAt: string }[];
        }>(url, ACTIVE_MERCHANTS_QUERY, { currency: currencyBytes32, first: PAGE, skip });
        for (const r of circleMerchants) byAddr.set(getAddress(r.merchant), Number(r.startedAt ?? '0'));
        if (circleMerchants.length < PAGE) break;
    }
    return [...byAddr].map(([addr, startedAt]) => ({ addr, startedAt }));
}

async function fetchLastAcceptedAt(url: string, addr: string, currencyBytes32: string): Promise<number> {
    const { orders_collection } = await gql<{ orders_collection: { acceptedAt: string }[] }>(
        url,
        LAST_ACCEPTED_QUERY,
        { addr: addr.toLowerCase(), currency: currencyBytes32 },
    );
    return orders_collection[0]?.acceptedAt ? Number(orders_collection[0].acceptedAt) : 0;
}

// Resolve an async predicate over a list with bounded concurrency, keep the passing items.
async function filterConcurrent<T>(items: T[], keep: (item: T) => Promise<boolean>): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < items.length; i += READ_CHUNK) {
        const slice = items.slice(i, i + READ_CHUNK);
        const flags = await Promise.all(slice.map(keep));
        slice.forEach((item, j) => flags[j] && out.push(item));
    }
    return out;
}

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

// ───────────────────────── Job 1: approveUnstakeBatch ───────────────────────
// approveUnstakeBatch is REVERT-ALL — a single ineligible entry reverts the
// whole tx. We strictly pre-validate every approveUnstake precondition on-chain,
// then eth_call-simulate each chunk and drop any straggler that still reverts
// before broadcasting via safeSend (which alerts on success/failure).
async function runApproveUnstake(diamond: Contract, config: ExecutorConfig): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const candidates = await fetchUnstakeRequestedMerchants(config.subgraphUrl);
    logger.info(`daily-keeper[job1]: subgraph isUnstakeRequested=${candidates.length}`);
    if (candidates.length === 0) return 'job1: 0 unstake-requested';

    const eligible = await filterConcurrent(candidates, async (m) => {
        // getUnstakeCooldownEndTime REVERTS if the merchant is not unstake-requested
        // on-chain (e.g. subgraph lag, or they cancelled between index and read). Guard
        // the whole probe so one stale candidate can't reject the chunk's Promise.all
        // and abort the entire job — treat any read failure as simply ineligible.
        try {
            // Blacklist is intentionally NOT a precondition: approveUnstake works on
            // blacklisted merchants (funds go to the merchant). Only the genuine
            // approveUnstake reverts are gated here.
            const [requested, cooldownEnd, ongoing] = await Promise.all([
                diamond.getUnstakeRequested(m),
                diamond.getUnstakeCooldownEndTime(m),
                diamond.hasOngoingOrder(m),
            ]);
            return requested && !ongoing && now >= Number(cooldownEnd);
        } catch (e: any) {
            logger.warn(`daily-keeper[job1]: skip ${m} (eligibility read reverted: ${e?.shortMessage ?? e?.message ?? e})`);
            return false;
        }
    });
    logger.info(`daily-keeper[job1]: on-chain validated eligible=${eligible.length}`);
    if (eligible.length === 0) return `job1: ${candidates.length} requested, 0 cooldown-elapsed`;

    let approved = 0;
    for (const part of chunk(eligible, TX_CHUNK)) {
        let toSend = part;
        try {
            await (diamond as any).approveUnstakeBatch.staticCall(part);
        } catch (e: any) {
            logger.warn(`daily-keeper[job1]: chunk sim reverted, re-validating per-merchant: ${e?.shortMessage ?? e?.message}`);
            toSend = [];
            for (const m of part) {
                try {
                    await (diamond as any).approveUnstakeBatch.staticCall([m]);
                    toSend.push(m);
                } catch {
                    logger.warn(`daily-keeper[job1]: skip ${m} (single-call still reverts)`);
                }
            }
        }
        if (toSend.length === 0) continue;
        // skipPresim=true: we already simulated this exact set above.
        const ok = await safeSend(diamond, 'approveUnstakeBatch', [toSend], config, { approveUnstakeBatch: toSend }, true);
        if (ok) approved += toSend.length;
    }
    return `job1: approved ${approved}/${eligible.length}`;
}

// ─────────────────── Job 2: blacklistInactiveMerchants ──────────────────────
// blacklistInactiveMerchants is skip-on-fail on-chain, so a superset is safe.
// We still pre-filter on getMerchantReactivatedAt so merchants inside their
// post-whitelist 30-day grace window are never submitted (saves gas).
async function runBlacklistInactive(diamond: Contract, config: ExecutorConfig): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const inactivityCutoff = now - MERCHANT_INACTIVITY_PERIOD;
    const graceCutoff = now - MERCHANT_INACTIVITY_PERIOD; // reactivated within 30d → still in grace

    const targets = new Set<string>();
    for (const ccy of CURRENCIES) {
        const ccyBytes = ccyToBytes32(ccy);
        const merchants = await fetchActiveMerchants(config.subgraphUrl, ccyBytes);
        if (merchants.length === 0) continue;

        // Guard: never propose a merchant who JOINED within the inactivity window.
        // A genuinely new merchant can't be 30d-idle; a re-onboarded address could
        // otherwise be flagged on a stale prior-life order (the on-chain grace only
        // covers removeBlacklist re-whitelist, not a fresh join), so exclude them
        // here up front. startedAt==0 (missing) is treated as "old" — not new.
        const eligibleByAge = merchants.filter((m) => !(m.startedAt > 0 && m.startedAt >= inactivityCutoff));
        const newlyJoined = merchants.length - eligibleByAge.length;

        // Accepted ≥1 order historically (last > 0) but none within the window.
        const idle = await filterConcurrent(eligibleByAge, async (m) => {
            const last = await fetchLastAcceptedAt(config.subgraphUrl, m.addr, ccyBytes);
            return last > 0 && last < inactivityCutoff;
        });

        // Drop freshly whitelisted (grace window) or already-blacklisted merchants.
        const final = await filterConcurrent(idle, async (m) => {
            const [reactivatedAt, blacklisted] = await Promise.all([
                diamond.getMerchantReactivatedAt(m.addr),
                diamond.isBlacklisted(m.addr),
            ]);
            return !blacklisted && Number(reactivatedAt) < graceCutoff;
        });

        for (const m of final) targets.add(m.addr);
        if (final.length > 0 || newlyJoined > 0) {
            logger.info(
                `daily-keeper[job2]: ${ccy} active=${merchants.length} newly-joined-skipped=${newlyJoined} idle=${idle.length} target=${final.length}`,
            );
        }
    }

    const list = [...targets];
    logger.info(`daily-keeper[job2]: total blacklist targets=${list.length}`);
    if (list.length === 0) return 'job2: 0 inactive targets';

    let submitted = 0;
    for (const part of chunk(list, TX_CHUNK)) {
        const ok = await safeSend(diamond, 'blacklistInactiveMerchants', [part], config, { blacklistInactiveMerchants: part });
        if (ok) submitted += part.length;
    }
    return `job2: submitted ${submitted}/${list.length}`;
}

export function startDailyKeeperWorker(config: ExecutorConfig, walletManager: WalletManager) {
    const signer = walletManager.getSigner(WalletRole.Keeper);
    const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, signer);

    initDailyKeeperQueue();

    const worker = new Worker(
        DAILY_KEEPER_QUEUE_NAME,
        async (_job) => {
            logger.info('⏰ daily-keeper: run starting');

            // Capability gate: approveUnstakeBatch, blacklistInactiveMerchants and
            // the grace getter getMerchantReactivatedAt all ship in the V26 upgrade.
            // Until it's deployed they revert with FunctionNotFound, so probe one
            // new read selector and skip the whole run cleanly rather than failing
            // (and alerting) every day. address(0) is a valid arg — returns 0 once live.
            try {
                await diamond.getMerchantReactivatedAt(ZeroAddress);
            } catch (err: any) {
                logger.warn(`daily-keeper: keeper functions not yet deployed (V26 pending) — skipping run (${err?.shortMessage ?? err?.message ?? err})`);
                return;
            }

            const job1 = await runApproveUnstake(diamond, config);
            const job2 = await runBlacklistInactive(diamond, config);
            const summary = `⏰ **Daily keeper run complete**\n↳ ${job1}\n↳ ${job2}`;
            logger.info(`daily-keeper: ${job1} | ${job2}`);
            await sendOnSuccess(config, summary);
        },
        {
            connection,
            concurrency: 1,
            lockDuration: LOCK_DURATION_MS,
        },
    );

    worker.on('error', (err) => logger.error(`❌ daily-keeper: worker error: ${err?.message}`));
    worker.on('completed', (job) => logger.info(`✅ daily-keeper: completed jobId=${job.id} ${job.name}`));
    worker.on('failed', async (job, err) => {
        logger.warn(`❌ daily-keeper: failed jobId=${job?.id} ${job?.name}: ${err?.message}`);
        await sendOnFail(config, `⏰ **Daily keeper run failed**\n↳ ${err?.message ?? err}`).catch(() => {});
    });

    logger.info('⏰ daily-keeper: started');
}
