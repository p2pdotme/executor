import { describe, expect, test } from 'bun:test';
import {
    FINALIZE_BUFFER_MS,
    FinalizeScanDeps,
    MAX_CHUNKS_PER_TICK,
    SCAN_CHUNK_BLOCKS,
    SCAN_CONFIRMATIONS,
    finalizeJobId,
    finalizeState,
    runFinalizeScan,
} from '../../../src/queue/workers/finalizeDispute';

const NOW_SEC = 1_794_000_000;
const NOW_MS = NOW_SEC * 1000;

type Log = { block: number; orderId: string; appealableUntil: bigint };

function fake(o: {
    head: number;
    cursor?: number | null;
    logs?: Log[];
    decisions?: Record<string, { decidedAt: bigint; appealableUntil: bigint }>;
    pending?: string[];
    failLogsFrom?: number;
}) {
    const state = {
        cursor: o.cursor ?? null,
        pending: new Set(o.pending ?? []),
        enqueued: [] as { orderId: string; jobId: string; delayMs: number }[],
        ranges: [] as [number, number][],
        calls: [] as string[],
    };
    const deps: FinalizeScanDeps = {
        head: async () => o.head,
        decidedLogs: async (from, to) => {
            if (o.failLogsFrom !== undefined && from >= o.failLogsFrom) throw new Error('rpc down');
            state.ranges.push([from, to]);
            return (o.logs ?? []).filter((l) => l.block >= from && l.block <= to);
        },
        decision: async (id) => o.decisions?.[id] ?? { decidedAt: 0n, appealableUntil: 0n },
        getCursor: async () => state.cursor,
        setCursor: async (b) => {
            state.calls.push(`cursor:${b}`);
            state.cursor = b;
        },
        pending: async () => [...state.pending],
        addPending: async (ids) => {
            state.calls.push(`pending:${ids.join(',')}`);
            ids.forEach((id) => state.pending.add(id));
        },
        dropPending: async (id) => {
            state.pending.delete(id);
        },
        enqueue: async (orderId, jobId, delayMs) => {
            state.enqueued.push({ orderId, jobId, delayMs });
        },
        nowMs: () => NOW_MS,
    };
    return { deps, state };
}

describe('finalizeState', () => {
    test('no pending decision is dropped', () => {
        expect(finalizeState({ decidedAt: 0n, appealableUntil: 0n }, NOW_SEC)).toBe('drop');
    });
    test('window still open is waiting', () => {
        expect(finalizeState({ decidedAt: 1n, appealableUntil: BigInt(NOW_SEC + 1) }, NOW_SEC)).toBe('wait');
    });
    test('window closed (inclusive) is due, matching finalizeDispute', () => {
        // The contract reverts only while block.timestamp < decidedAt + window.
        expect(finalizeState({ decidedAt: 1n, appealableUntil: BigInt(NOW_SEC) }, NOW_SEC)).toBe('due');
    });
});

describe('finalizeJobId', () => {
    test('carries the deadline so a re-decided appeal gets its own job', () => {
        expect(finalizeJobId('844210', 1794098397n)).toBe('finalize-844210-1794098397');
        expect(finalizeJobId('844210', 1n)).not.toBe(finalizeJobId('844210', 2n));
    });
});

describe('runFinalizeScan', () => {
    test('first run starts at fromBlock, stops CONFIRMATIONS behind head, chunks the range', async () => {
        const { deps, state } = fake({ head: 100 + SCAN_CHUNK_BLOCKS + 10 });
        const r = await runFinalizeScan(deps, 100);
        const to = 100 + SCAN_CHUNK_BLOCKS + 10 - SCAN_CONFIRMATIONS;
        expect(state.ranges).toEqual([
            [100, 100 + SCAN_CHUNK_BLOCKS - 1],
            [100 + SCAN_CHUNK_BLOCKS, to],
        ]);
        expect(state.cursor).toBe(to);
        expect(r.scanned).toEqual([100, to]);
    });

    test('resumes after the cursor and ignores fromBlock', async () => {
        const { deps, state } = fake({ head: 1_000, cursor: 900 });
        await runFinalizeScan(deps, 1);
        expect(state.ranges).toEqual([[901, 995]]);
    });

    test('nothing new when the cursor is at head − confirmations', async () => {
        const { deps, state } = fake({ head: 1_000, cursor: 995 });
        const r = await runFinalizeScan(deps, 1);
        expect(state.ranges).toEqual([]);
        expect(r.scanned).toBeNull();
    });

    test('a tick scans at most MAX_CHUNKS_PER_TICK chunks', async () => {
        const { deps, state } = fake({ head: 10_000_000 });
        await runFinalizeScan(deps, 1);
        expect(state.ranges.length).toBe(MAX_CHUNKS_PER_TICK);
        expect(state.cursor).toBe(MAX_CHUNKS_PER_TICK * SCAN_CHUNK_BLOCKS);
    });

    test('pending is written before the cursor moves past a decision', async () => {
        const { deps, state } = fake({
            head: 1_000,
            cursor: 0,
            logs: [{ block: 10, orderId: '7', appealableUntil: BigInt(NOW_SEC + 60) }],
            decisions: { '7': { decidedAt: 1n, appealableUntil: BigInt(NOW_SEC + 60) } },
        });
        await runFinalizeScan(deps, 1);
        expect(state.calls).toEqual(['pending:7', 'cursor:995']);
    });

    test('a failed getLogs keeps the cursor at the last good chunk', async () => {
        const { deps, state } = fake({ head: 10 * SCAN_CHUNK_BLOCKS, cursor: 0, failLogsFrom: SCAN_CHUNK_BLOCKS + 1 });
        await expect(runFinalizeScan(deps, 1)).rejects.toThrow('rpc down');
        expect(state.cursor).toBe(SCAN_CHUNK_BLOCKS);
    });

    test('tier-3 decisions (appealableUntil 0) are not tracked', async () => {
        const { deps, state } = fake({
            head: 1_000,
            cursor: 0,
            logs: [{ block: 10, orderId: '9', appealableUntil: 0n }],
        });
        const r = await runFinalizeScan(deps, 1);
        expect(state.pending.size).toBe(0);
        expect(r.found).toBe(0);
    });

    test('waiting dispute is scheduled at its live deadline + buffer', async () => {
        const until = BigInt(NOW_SEC + 3600);
        const { deps, state } = fake({
            head: 1_000,
            cursor: 995,
            pending: ['844210'],
            // the event said one deadline; the live getter says another
            decisions: { '844210': { decidedAt: 1n, appealableUntil: until } },
        });
        const r = await runFinalizeScan(deps, 1);
        expect(r.waiting).toEqual(['844210']);
        expect(state.enqueued).toEqual([
            { orderId: '844210', jobId: `finalize-844210-${until}`, delayMs: 3600 * 1000 + FINALIZE_BUFFER_MS },
        ]);
        expect(state.pending.has('844210')).toBe(true);
    });

    test('due dispute is enqueued now and stays pending until the chain clears it', async () => {
        const until = BigInt(NOW_SEC - 10);
        const { deps, state } = fake({
            head: 1_000,
            cursor: 995,
            pending: ['844262'],
            decisions: { '844262': { decidedAt: 1n, appealableUntil: until } },
        });
        const r = await runFinalizeScan(deps, 1);
        expect(r.due).toEqual(['844262']);
        expect(state.enqueued).toEqual([{ orderId: '844262', jobId: `finalize-844262-${until}`, delayMs: 0 }]);
        expect(state.pending.has('844262')).toBe(true);
    });

    test('a dispute with no pending decision leaves the set and is not enqueued', async () => {
        const { deps, state } = fake({ head: 1_000, cursor: 995, pending: ['5'] });
        const r = await runFinalizeScan(deps, 1);
        expect(r.dropped).toEqual(['5']);
        expect(state.pending.size).toBe(0);
        expect(state.enqueued).toEqual([]);
    });
});
