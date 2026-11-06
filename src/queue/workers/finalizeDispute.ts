import { Job } from 'bullmq';
import { Contract } from 'ethers';
import { ExecutorConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import { DISPUTE_ABI } from '../../helpers/disputeAbi';
import { FinalizeDisputeJobData } from '../types';
import { safeSend } from '../../helpers/safeSend';
import { sendOnFail } from '../../helpers/alerts';
import { redactError } from '../../helpers/redact';
import { WalletManager, WalletRole } from '../../helpers/walletManager';

// Dispute finalize keeper: executes tier-1 / tier-2 dispute decisions once
// their appeal window has passed, by calling the permissionless
// finalizeDispute(orderId) on the main Diamond. Without a caller the order stays
// disputeInfo.status RAISED, the merchant stays flagged disputed (no new
// orders), and the refund / completion never happens.
//
// Two parts:
//   - runFinalizeScan (driven by disputeFinalizeScannerWorker, its own queue,
//     no wallet): replays DisputeDecided logs from a Redis cursor into a Redis
//     pending set, then schedules one job per pending dispute at its deadline.
//   - createFinalizeDisputeHandler: the job itself, on the daily-keeper queue so
//     the Keeper wallet keeps exactly one consumer (see dailyKeeperWorker.ts).
//
// The pending set, not the job, is the record of what still needs finalizing:
// a job whose presim reverts completes and is removed. A dispute leaves the set
// only when getDisputeDecision says nothing is pending any more.

// Lands the tx a little after the deadline so presim never sees the window open.
export const FINALIZE_BUFFER_MS = 15_000;
// Same getLogs range the executor already uses in prod (syncOrderIds, OrderCompleted gap replay).
export const SCAN_CHUNK_BLOCKS = 2_500;
// Bounds one tick; a first-boot catch-up finishes over a few ticks.
export const MAX_CHUNKS_PER_TICK = 20;
// Stay behind head so a reorged-out decision block is not folded in and skipped.
export const SCAN_CONFIRMATIONS = 5;

export type DisputeDecision = { decidedAt: bigint; appealableUntil: bigint };
export type FinalizeState = 'drop' | 'wait' | 'due';

export function finalizeState(d: DisputeDecision, nowSec: number): FinalizeState {
    if (d.decidedAt === 0n) return 'drop';
    return d.appealableUntil > BigInt(nowSec) ? 'wait' : 'due';
}

// The deadline is part of the id: an appeal that is decided again has a new
// deadline and must get its own job instead of being deduped into the old one.
export function finalizeJobId(orderId: string, appealableUntil: bigint): string {
    return `finalize-${orderId}-${appealableUntil}`;
}

export type FinalizeScanDeps = {
    head(): Promise<number>;
    decidedLogs(fromBlock: number, toBlock: number): Promise<{ orderId: string; appealableUntil: bigint }[]>;
    decision(orderId: string): Promise<DisputeDecision>;
    getCursor(): Promise<number | null>;
    setCursor(block: number): Promise<void>;
    pending(): Promise<string[]>;
    addPending(orderIds: string[]): Promise<void>;
    dropPending(orderId: string): Promise<void>;
    enqueue(orderId: string, jobId: string, delayMs: number): Promise<void>;
    nowMs(): number;
};

export type FinalizeScanResult = {
    scanned: [number, number] | null;
    found: number;
    due: string[];
    waiting: string[];
    dropped: string[];
};

export async function runFinalizeScan(deps: FinalizeScanDeps, fromBlock: number): Promise<FinalizeScanResult> {
    const to = (await deps.head()) - SCAN_CONFIRMATIONS;
    const cursor = await deps.getCursor();
    const first = cursor === null ? fromBlock : cursor + 1;
    let start = first;
    let found = 0;
    for (let chunks = 0; start <= to && chunks < MAX_CHUNKS_PER_TICK; chunks++) {
        const end = Math.min(start + SCAN_CHUNK_BLOCKS - 1, to);
        const ids = (await deps.decidedLogs(start, end))
            .filter((l) => l.appealableUntil !== 0n) // tier 3 settled in the same tx
            .map((l) => l.orderId);
        // Pending first, then the cursor: a crash in between rescans this chunk
        // instead of losing a decision.
        if (ids.length) await deps.addPending(ids);
        await deps.setCursor(end);
        found += ids.length;
        start = end + 1;
    }

    const result: FinalizeScanResult = {
        scanned: start > first ? [first, start - 1] : null,
        found,
        due: [],
        waiting: [],
        dropped: [],
    };
    const nowMs = deps.nowMs();
    const nowSec = Math.floor(nowMs / 1000);
    for (const orderId of await deps.pending()) {
        const d = await deps.decision(orderId);
        const state = finalizeState(d, nowSec);
        if (state === 'drop') {
            await deps.dropPending(orderId);
            result.dropped.push(orderId);
            continue;
        }
        const delayMs = state === 'wait' ? Number(d.appealableUntil) * 1000 - nowMs + FINALIZE_BUFFER_MS : 0;
        await deps.enqueue(orderId, finalizeJobId(orderId, d.appealableUntil), delayMs);
        result[state === 'due' ? 'due' : 'waiting'].push(orderId);
    }
    return result;
}

export type FinalizeDisputeHandler = (job: Job<FinalizeDisputeJobData>) => Promise<void>;

// A HANDLER, not a Worker: it rides the daily-keeper queue for the same reason
// as settleClaimJob.ts. Presims itself and alerts once per order, so a dispute
// that cannot be finalized does not ping Discord on every scanner tick.
export function createFinalizeDisputeHandler(
    config: ExecutorConfig,
    walletManager: WalletManager,
): FinalizeDisputeHandler {
    const signer = walletManager.getSigner(WalletRole.Keeper);
    const diamond = new Contract(config.diamondAddress, DISPUTE_ABI, signer);
    // Cleared on restart, which is the right cadence for a re-reminder.
    const alertedOrders = new Set<string>();

    return async function finalizeDispute(job) {
        const { orderId } = job.data;
        if (!orderId) {
            logger.error(`finalize-dispute: missing orderId jobId= ${job.id}`);
            return;
        }

        try {
            // The live getter, not the job's deadline: the appeal window is per
            // currency and read at finalize time, and the dispute may have been
            // finalized by someone else or appealed since the job was scheduled.
            const d = await (diamond as any).getDisputeDecision(orderId);
            const state = finalizeState(
                { decidedAt: d.decidedAt, appealableUntil: d.appealableUntil },
                Math.floor(Date.now() / 1000),
            );
            if (state === 'drop') {
                logger.info(`finalize-dispute: orderId= ${orderId} has no pending decision — nothing to do`);
                return;
            }
            if (state === 'wait') {
                // The scanner schedules a new job at the new deadline.
                logger.info(`finalize-dispute: orderId= ${orderId} appeal window open until ${d.appealableUntil} — waiting`);
                return;
            }

            try {
                await (diamond as any).finalizeDispute.staticCall(orderId);
            } catch (simErr: any) {
                const reason = redactError(simErr);
                logger.warn(`finalize-dispute: presim reverted orderId= ${orderId} — skipping: ${reason}`);
                if (!alertedOrders.has(orderId)) {
                    alertedOrders.add(orderId);
                    await sendOnFail(
                        config,
                        `finalizeDispute | staticCall reverted | orderId=${orderId}\n↳ ${reason}\n↳ further failures for this order are suppressed until restart`,
                    );
                }
                return;
            }
            alertedOrders.delete(orderId);

            // skipPresim=true: we just simulated this exact call above.
            const ok = await safeSend(diamond, 'finalizeDispute', [orderId], config, { orderId }, true);
            if (ok) logger.info(`✅ finalize-dispute: finalized orderId= ${orderId} jobId= ${job.id}`);
            else logger.warn(`finalize-dispute: send skipped/failed orderId= ${orderId} jobId= ${job.id} (safeSend already alerted)`);
        } catch (err: any) {
            const reason = redactError(err);
            logger.error(`finalize-dispute error orderId= ${orderId} jobId= ${job.id}: ${reason}`);
            if (!(err as any)._alerted) {
                await sendOnFail(config, `Finalize-dispute error\nOrderId= ${orderId}\nJobId= ${job.id}\n↳ ${reason}`);
            }
            throw err; // transient (nonce/network) → BullMQ retries
        }
    };
}
