import { beforeEach, describe, expect, test } from 'bun:test';
import type { WinnerRow } from '../../../src/prizerail/store';
import { payWinner, PayoutDeps, UNCONFIRMED_DEADLINE_MS, UNSENT_GRACE_MS } from '../../../src/queue/workers/prizerailPayoutWorker';

const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PRIZE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const NOW = 1_700_000_000_000;

function row(over: Partial<WinnerRow> = {}): WinnerRow {
    return {
        campaign: 'c',
        drawingId: 'd1',
        position: 0,
        drawingNumber: 1,
        drawingStatus: 'paid',
        drawAt: '2026-11-03T17:00:00.000Z',
        entrantId: 'e',
        wallet: WALLET,
        amountCents: 1500,
        heldForManualPayout: false,
        payoutStatus: 'pending',
        holdReason: null,
        alerted: true,
        txHash: null,
        paidAt: null,
        attempts: 0,
        lastError: null,
        sendNonce: null,
        recordedAt: NOW - 1000,
        updatedAt: NOW - 1000,
        ...over,
    };
}

type Fake = {
    deps: PayoutDeps;
    calls: string[];
    state: { row: WinnerRow | null };
};

function fake(initial: WinnerRow | null, over: Partial<PayoutDeps> = {}): Fake {
    const calls: string[] = [];
    const state = { row: initial };
    const store: PayoutDeps['store'] = {
        getWinner: async () => state.row,
        claimPayout: async () => {
            if (state.row?.payoutStatus !== 'pending') return null;
            state.row = { ...state.row, payoutStatus: 'paying', attempts: state.row.attempts + 1 };
            calls.push('claim');
            return state.row;
        },
        releaseClaim: async (_c, _d, _p, reason) => {
            calls.push(`release:${reason}`);
            if (state.row) state.row = { ...state.row, payoutStatus: 'pending', lastError: reason };
        },
        recordSendNonce: async (_c, _d, _p, nonce) => {
            calls.push(`nonce:${nonce}`);
            if (state.row) state.row = { ...state.row, sendNonce: nonce };
        },
        recordTxHash: async (_c, _d, _p, hash) => {
            calls.push(`hash:${hash}`);
            if (state.row) state.row = { ...state.row, txHash: hash };
        },
        markPaid: async (_c, _d, _p, hash) => {
            calls.push(`paid:${hash}`);
            if (state.row) state.row = { ...state.row, payoutStatus: 'paid', txHash: hash };
        },
        markManual: async (_c, _d, _p, reason) => {
            calls.push(`manual:${reason}`);
            if (state.row) state.row = { ...state.row, payoutStatus: 'manual', lastError: reason };
        },
        markFailed: async (_c, _d, _p, reason) => {
            calls.push(`failed:${reason}`);
            if (state.row) state.row = { ...state.row, payoutStatus: 'failed', lastError: reason };
        },
    };
    const deps: PayoutDeps = {
        dryRun: false,
        campaign: 'c',
        prizeAddress: PRIZE,
        minBalance: 100_000_000n,
        store,
        balanceOf: async () => 1_000_000_000n,
        minedNonce: async () => 7,
        receiptStatus: async () => null,
        transfer: async (_to, _amount, onSent) => {
            calls.push('send');
            await onSent('0xhash');
            return true;
        },
        alertSuccess: async (m) => {
            calls.push(`ok:${m.slice(0, 12)}`);
        },
        alertFail: async (m) => {
            calls.push(`fail:${m.slice(0, 20)}`);
        },
        alertBalance: async () => {
            calls.push('balance-alert');
        },
        now: () => NOW,
        balanceAlert: { lastAt: 0 },
        ...over,
    };
    return { deps, calls, state };
}

const job = { campaign: 'c', drawingId: 'd1', position: 0 };

describe('payWinner — happy path and guards', () => {
    test('claims, snapshots nonce, sends, persists hash before paid, alerts', async () => {
        const f = fake(row());
        await payWinner(f.deps, job);
        expect(f.calls).toEqual(['claim', 'nonce:7', 'send', 'hash:0xhash', 'paid:0xhash', 'ok:🎟️ Prize pa']);
        expect(f.state.row?.payoutStatus).toBe('paid');
    });

    test('dry run touches nothing', async () => {
        const f = fake(row());
        f.deps.dryRun = true;
        await payWinner(f.deps, job);
        expect(f.calls).toEqual([]);
        expect(f.state.row?.payoutStatus).toBe('pending');
    });

    test('dry run leaves an in-flight row alone', async () => {
        const f = fake(row({ payoutStatus: 'paying', txHash: '0xold' }));
        f.deps.dryRun = true;
        f.deps.receiptStatus = async () => 1;
        await payWinner(f.deps, job);
        expect(f.calls).toEqual([]);
    });

    test('does nothing for held, paid, manual, failed or missing rows', async () => {
        for (const status of ['held', 'paid', 'manual', 'failed', 'unresolved_entrant'] as const) {
            const f = fake(row({ payoutStatus: status }));
            await payWinner(f.deps, job);
            expect(f.calls).toEqual([]);
        }
        const none = fake(null);
        await payWinner(none.deps, job);
        expect(none.calls).toEqual([]);
    });

    test('insufficient balance releases the claim and throws for a later retry', async () => {
        const f = fake(row(), { balanceOf: async () => 1_000_000n });
        await expect(payWinner(f.deps, job)).rejects.toThrow(/insufficient/);
        expect(f.calls).toEqual(['claim', 'balance-alert', 'release:insufficient USDC in prize wallet']);
        expect(f.state.row?.payoutStatus).toBe('pending');
    });

    test('an RPC error reading the balance releases the claim and throws — nothing sent', async () => {
        const f = fake(row(), {
            balanceOf: async () => {
                throw new Error('rpc timeout');
            },
        });
        await expect(payWinner(f.deps, job)).rejects.toThrow(/rpc timeout/);
        expect(f.calls).toEqual(['claim', 'release:pre-send RPC read failed: rpc timeout']);
        expect(f.state.row?.payoutStatus).toBe('pending');
    });

    test('an RPC error reading the nonce releases the claim and throws — nothing sent', async () => {
        const f = fake(row(), {
            minedNonce: async () => {
                throw new Error('rpc 429');
            },
        });
        await expect(payWinner(f.deps, job)).rejects.toThrow(/rpc 429/);
        expect(f.calls).toEqual(['claim', 'release:pre-send RPC read failed: rpc 429']);
        expect(f.state.row?.payoutStatus).toBe('pending');
        expect(f.state.row?.sendNonce).toBeNull();
    });

    test('balance alert is rate-limited across calls', async () => {
        const f = fake(row(), { balanceOf: async () => 1_000_000n });
        await payWinner(f.deps, job).catch(() => {});
        await payWinner(f.deps, job).catch(() => {});
        expect(f.calls.filter((c) => c === 'balance-alert')).toHaveLength(1);
    });

    test('a sent-but-reverted transfer goes to manual with the hash kept', async () => {
        const f = fake(row(), {
            transfer: async (_t, _a, onSent) => {
                await onSent('0xrev');
                return false;
            },
        });
        await payWinner(f.deps, job);
        expect(f.state.row?.payoutStatus).toBe('manual');
        expect(f.state.row?.txHash).toBe('0xrev');
    });

    test('a rejected-before-broadcast transfer goes to failed', async () => {
        const f = fake(row(), { transfer: async () => false });
        await payWinner(f.deps, job);
        expect(f.state.row?.payoutStatus).toBe('failed');
        expect(f.state.row?.txHash).toBeNull();
    });

    test('an ambiguous send error keeps the row paying — never released, never re-sent', async () => {
        const f = fake(row(), {
            transfer: async () => {
                throw new Error('SERVER_ERROR');
            },
        });
        await expect(payWinner(f.deps, job)).rejects.toThrow('SERVER_ERROR');
        expect(f.state.row?.payoutStatus).toBe('paying');
        expect(f.calls.some((c) => c.startsWith('release'))).toBe(false);
    });
});

describe('payWinner — reconciling an in-flight row', () => {
    const inflight = (over: Partial<WinnerRow> = {}) => row({ payoutStatus: 'paying', sendNonce: 7, updatedAt: NOW - 1000, ...over });

    beforeEach(() => {
        // nothing shared between cases
    });

    test('hash + success receipt → paid, no new send', async () => {
        const f = fake(inflight({ txHash: '0xsent' }), { receiptStatus: async () => 1 });
        await payWinner(f.deps, job);
        expect(f.calls).toEqual(['paid:0xsent']);
    });

    test('hash + reverted receipt → manual + alert', async () => {
        const f = fake(inflight({ txHash: '0xsent' }), { receiptStatus: async () => 0 });
        await payWinner(f.deps, job);
        expect(f.state.row?.payoutStatus).toBe('manual');
        expect(f.calls.some((c) => c.startsWith('fail:'))).toBe(true);
    });

    test('hash + no receipt → retry while young, manual past the deadline', async () => {
        const young = fake(inflight({ txHash: '0xsent' }));
        await expect(payWinner(young.deps, job)).rejects.toThrow(/still pending/);
        expect(young.state.row?.payoutStatus).toBe('paying');

        const old = fake(inflight({ txHash: '0xsent', updatedAt: NOW - UNCONFIRMED_DEADLINE_MS - 1 }));
        await payWinner(old.deps, job);
        expect(old.state.row?.payoutStatus).toBe('manual');
    });

    test('no hash, nonce moved → manual (a transfer may have been mined)', async () => {
        const f = fake(inflight(), { minedNonce: async () => 8 });
        await payWinner(f.deps, job);
        expect(f.state.row?.payoutStatus).toBe('manual');
        expect(f.calls.some((c) => c === 'send')).toBe(false);
    });

    test('no hash, nonce unmoved → retry while young, release after the grace period', async () => {
        const young = fake(inflight());
        await expect(payWinner(young.deps, job)).rejects.toThrow(/no hash yet/);
        expect(young.state.row?.payoutStatus).toBe('paying');

        const old = fake(inflight({ updatedAt: NOW - UNSENT_GRACE_MS - 1 }));
        await payWinner(old.deps, job);
        expect(old.state.row?.payoutStatus).toBe('pending');
    });

    test('no hash and no nonce snapshot → manual', async () => {
        const f = fake(inflight({ sendNonce: null }));
        await payWinner(f.deps, job);
        expect(f.state.row?.payoutStatus).toBe('manual');
    });
});
