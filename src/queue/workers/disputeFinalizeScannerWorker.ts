import { Worker } from 'bullmq';
import { Contract, EventLog } from 'ethers';
import { ExecutorConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import { DISPUTE_ABI } from '../../helpers/disputeAbi';
import { getBaseHttpProvider, withTimeout } from '../../helpers/provider';
import { redactError } from '../../helpers/redact';
import {
    DISPUTE_FINALIZE_SCANNER_QUEUE_NAME,
    initDisputeFinalizeScannerQueue,
    addFinalizeDisputeJob,
    connection,
} from '../index';
import { FinalizeScanDeps, runFinalizeScan } from './finalizeDispute';

const LOCK_DURATION_MS = 180_000; // 3 min
const JOB_TIMEOUT_MS = 150_000; // hard deadline, under the lock
const RPC_TIMEOUT_MS = 20_000;
const CURSOR_KEY = 'dispute-finalize:cursor';
const PENDING_KEY = 'dispute-finalize:pending';
// Base mainnet block of the R8 main cut (2026-11-07 00:41 IST), the first block
// a DisputeDecided can be in. Override with DISPUTE_FINALIZE_FROM_BLOCK on
// another chain. Only read when there is no cursor in Redis yet.
const DEFAULT_FROM_BLOCK = 54_009_557;
const SEED_PAGE = 1000;

type SeedRow = { orderId: string };

async function gql<T>(url: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`subgraph HTTP ${res.status}`);
    const json = (await res.json()) as { data?: T; errors?: unknown };
    if (json.errors || !json.data) throw new Error(`subgraph errors: ${JSON.stringify(json.errors ?? 'empty data').slice(0, 300)}`);
    return json.data;
}

// Orders whose tier-1/2 decision is still pending, all read at ONE block so the
// cursor handed to the log scan matches what was seeded.
export async function seedFromSubgraph(url: string): Promise<{ orderIds: string[]; block: number }> {
    const { _meta } = await gql<{ _meta: { block: { number: number }; hasIndexingErrors: boolean } }>(
        url,
        '{ _meta { block { number } hasIndexingErrors } }',
        {},
    );
    if (_meta.hasIndexingErrors) throw new Error('subgraph has indexing errors');
    const block = Number(_meta.block.number);
    const orderIds: string[] = [];
    for (let after = '-1'; ; ) {
        const { orders_collection: rows } = await gql<{ orders_collection: SeedRow[] }>(
            url,
            `query Seed($block: Int!, $after: BigInt!, $first: Int!) {
                orders_collection(block: { number: $block }, first: $first, orderBy: orderId, orderDirection: asc,
                    where: { disputeAppealableUntil_gt: "0", orderId_gt: $after }) { orderId }
            }`,
            { block, after, first: SEED_PAGE },
        );
        for (const r of rows) orderIds.push(String(r.orderId));
        if (rows.length < SEED_PAGE) break;
        after = String(rows[rows.length - 1].orderId);
    }
    return { orderIds, block };
}

// Finds tier-1 / tier-2 dispute decisions and schedules their finalizeDispute
// jobs on the daily-keeper queue. Reads the chain, not the subgraph, and sends
// no transactions, so it touches no wallet and keeps its own queue.
export function startDisputeFinalizeScannerWorker(config: ExecutorConfig) {
    initDisputeFinalizeScannerQueue();
    const provider = getBaseHttpProvider(config);
    const diamond = new Contract(config.diamondAddress, DISPUTE_ABI, provider);
    const envFrom = Number(process.env.DISPUTE_FINALIZE_FROM_BLOCK);
    const fromBlock = Number.isInteger(envFrom) && envFrom > 0 ? envFrom : DEFAULT_FROM_BLOCK;

    const deps: FinalizeScanDeps = {
        head: () => withTimeout(provider.getBlockNumber(), RPC_TIMEOUT_MS),
        decidedLogs: async (from, to) => {
            const logs = await withTimeout(
                diamond.queryFilter(diamond.filters.DisputeDecided(), from, to),
                RPC_TIMEOUT_MS,
            );
            return (logs as EventLog[]).map((l) => ({
                orderId: String(l.args.orderId),
                appealableUntil: BigInt(l.args.appealableUntil),
            }));
        },
        decision: async (orderId) => {
            const d: any = await withTimeout((diamond as any).getDisputeDecision(orderId), RPC_TIMEOUT_MS);
            return { decidedAt: BigInt(d.decidedAt), appealableUntil: BigInt(d.appealableUntil) };
        },
        getCursor: async () => {
            const v = await connection.get(CURSOR_KEY);
            return v === null ? null : Number(v);
        },
        setCursor: async (block) => {
            await connection.set(CURSOR_KEY, String(block));
        },
        pending: () => connection.smembers(PENDING_KEY),
        addPending: async (ids) => {
            await connection.sadd(PENDING_KEY, ...ids);
        },
        dropPending: async (id) => {
            await connection.srem(PENDING_KEY, id);
        },
        enqueue: async (orderId, jobId, delayMs) => {
            await addFinalizeDisputeJob({ orderId }, { jobId, delayMs });
        },
        nowMs: () => Date.now(),
        seed: config.subgraphUrl ? () => withTimeout(seedFromSubgraph(config.subgraphUrl), RPC_TIMEOUT_MS * 3) : undefined,
        onSeedError: (err) =>
            logger.warn(`dispute-finalize-scanner: subgraph seed failed, replaying logs instead: ${redactError(err)}`),
    };

    const worker = new Worker(
        DISPUTE_FINALIZE_SCANNER_QUEUE_NAME,
        async () => {
            // Capability gate: before the R8 cut the getter does not exist and
            // reverts. Skip the tick quietly instead of failing it every time.
            try {
                await withTimeout((diamond as any).getDisputeDecision(0), RPC_TIMEOUT_MS);
            } catch (err) {
                logger.warn(`dispute-finalize-scanner: getDisputeDecision unavailable (pre-R8 Diamond?) — skipping tick: ${redactError(err)}`);
                return;
            }
            const r = await withTimeout(runFinalizeScan(deps, fromBlock), JOB_TIMEOUT_MS);
            logger.info(
                (r.seeded !== null ? `dispute-finalize-scanner: seeded ${r.seeded} pending decision(s) from the subgraph; ` : '') +
                `dispute-finalize-scanner: scanned ${r.scanned ? `${r.scanned[0]}..${r.scanned[1]}` : 'nothing new'}, ${r.found} new decision(s); ` +
                    `${r.due.length} due, ${r.waiting.length} waiting, ${r.dropped.length} dropped`,
            );
        },
        { connection, concurrency: 1, lockDuration: LOCK_DURATION_MS },
    );

    worker.on('error', (err) => logger.error(`dispute-finalize-scanner: worker error: ${redactError(err)}`));
    worker.on('failed', (job, err) =>
        logger.warn(`dispute-finalize-scanner: failed jobId=${job?.id} ${job?.name}: ${redactError(err)}`),
    );

    logger.info(`dispute-finalize-scanner: started (first block ${fromBlock} when no cursor)`);
}
