import { describe, expect, test } from 'bun:test';
import { AbiCoder, zeroPadValue } from 'ethers';
import type { WinnerRow } from '../../src/prizerail/store';
import { ManualPayoutDeps, runManualPayout, TRANSFER_TOPIC } from '../../src/prizerail/manualPayout';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WALLET = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PRIZE = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH = '0x' + '1'.repeat(64);

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
        amountCents: 5000,
        heldForManualPayout: false,
        payoutStatus: 'held',
        holdReason: 'amount 5000c at or above auto-payout cap 2000c',
        alerted: true,
        txHash: null,
        paidAt: null,
        attempts: 0,
        lastError: null,
        sendNonce: null,
        recordedAt: 0,
        updatedAt: 0,
        ...over,
    };
}

const transferLog = (to: string, cents: number, token = USDC) => ({
    address: token,
    topics: [TRANSFER_TOPIC, zeroPadValue(PRIZE, 32), zeroPadValue(to, 32)],
    data: AbiCoder.defaultAbiCoder().encode(['uint256'], [BigInt(cents) * 10_000n]),
});

function fake(initial: WinnerRow | null, over: Partial<ManualPayoutDeps> = {}) {
    const calls: string[] = [];
    const state = { row: initial };
    const deps: ManualPayoutDeps = {
        campaign: 'c',
        usdcAddress: USDC,
        actor: 'ops',
        store: {
            getWinner: async () => state.row,
            listNeedsAttention: async () => (state.row ? [state.row] : []),
            findPaidByTxHash: async () => [],
            approveHeld: async (_c, _d, _p, note) => {
                calls.push(`approve:${note}`);
                return true;
            },
            retryFailed: async (_c, _d, _p, note) => {
                calls.push(`retry:${note}`);
                return true;
            },
            markPaidByHand: async (_c, _d, _p, from, hash, note) => {
                calls.push(`paid:${from}:${hash}:${note}`);
                return true;
            },
        },
        getReceipt: async () => ({ status: 1, logs: [transferLog(WALLET, 5000)] }),
        ...over,
    };
    return { deps, calls };
}

describe('runManualPayout', () => {
    test('list prints every row that needs a human', async () => {
        const f = fake(row());
        const out = await runManualPayout(['list'], f.deps);
        expect(out.join('\n')).toContain('d1 #0');
        expect(out.join('\n')).toContain('$50.00');
        expect(out.join('\n')).toContain('held');
    });

    test('approve: over-cap held row goes back to pending', async () => {
        const f = fake(row());
        await runManualPayout(['approve', 'd1', '0'], f.deps);
        expect(f.calls).toEqual(['approve:approved for auto-pay by ops']);
    });

    test('approve refuses a Prizerail hold, a missing wallet and a non-held row', async () => {
        await expect(runManualPayout(['approve', 'd1', '0'], fake(row({ heldForManualPayout: true })).deps)).rejects.toThrow(/Prizerail/);
        await expect(runManualPayout(['approve', 'd1', '0'], fake(row({ wallet: null })).deps)).rejects.toThrow(/wallet/);
        await expect(runManualPayout(['approve', 'd1', '0'], fake(row({ payoutStatus: 'manual' })).deps)).rejects.toThrow(/manual/);
        await expect(runManualPayout(['approve', 'd1', '0'], fake(null).deps)).rejects.toThrow(/no winner/);
    });

    test('retry only moves a failed row', async () => {
        const f = fake(row({ payoutStatus: 'failed' }));
        await runManualPayout(['retry', 'd1', '0'], f.deps);
        expect(f.calls).toEqual(['retry:retry requested by ops']);
        await expect(runManualPayout(['retry', 'd1', '0'], fake(row({ payoutStatus: 'manual' })).deps)).rejects.toThrow(/mark-paid/);
    });

    test('mark-paid records a verified USDC transfer of the exact amount to the winner', async () => {
        const f = fake(row());
        await runManualPayout(['mark-paid', 'd1', '0', HASH], f.deps);
        expect(f.calls).toEqual([`paid:held:${HASH}:paid by hand, recorded by ops`]);
    });

    test('mark-paid works for a manual row whose transfer did land', async () => {
        const f = fake(row({ payoutStatus: 'manual', txHash: HASH }));
        await runManualPayout(['mark-paid', 'd1', '0', HASH], f.deps);
        expect(f.calls[0]).toStartWith('paid:manual:');
    });

    test('mark-paid refuses anything it cannot prove', async () => {
        const cases: [Partial<ManualPayoutDeps>, RegExp][] = [
            [{ getReceipt: async () => null }, /not mined/],
            [{ getReceipt: async () => ({ status: 0, logs: [transferLog(WALLET, 5000)] }) }, /reverted/],
            [{ getReceipt: async () => ({ status: 1, logs: [transferLog(PRIZE, 5000)] }) }, /no USDC transfer/],
            [{ getReceipt: async () => ({ status: 1, logs: [transferLog(WALLET, 4999)] }) }, /no USDC transfer/],
            [{ getReceipt: async () => ({ status: 1, logs: [transferLog(WALLET, 5000, PRIZE)] }) }, /no USDC transfer/],
        ];
        for (const [over, err] of cases) {
            const f = fake(row(), over);
            await expect(runManualPayout(['mark-paid', 'd1', '0', HASH], f.deps)).rejects.toThrow(err);
            expect(f.calls).toEqual([]);
        }
    });

    test('mark-paid refuses a transfer already recorded for another winner', async () => {
        const f = fake(row());
        f.deps.store.findPaidByTxHash = async () => [row({ drawingId: 'd0', payoutStatus: 'paid', txHash: HASH })];
        await expect(runManualPayout(['mark-paid', 'd1', '0', HASH], f.deps)).rejects.toThrow(/already recorded/);
        expect(f.calls).toEqual([]);
    });

    test('mark-paid refuses paid, pending and paying rows and a malformed hash', async () => {
        for (const status of ['paid', 'pending', 'paying', 'unresolved_entrant'] as const) {
            await expect(runManualPayout(['mark-paid', 'd1', '0', HASH], fake(row({ payoutStatus: status })).deps)).rejects.toThrow(status);
        }
        await expect(runManualPayout(['mark-paid', 'd1', '0', '0x12'], fake(row()).deps)).rejects.toThrow(/tx hash/);
    });

    test('a row that moved between read and write is reported, not overwritten', async () => {
        const f = fake(row());
        f.deps.store.approveHeld = async () => false;
        await expect(runManualPayout(['approve', 'd1', '0'], f.deps)).rejects.toThrow(/changed/);
    });

    test('bad usage prints help', async () => {
        await expect(runManualPayout([], fake(row()).deps)).rejects.toThrow(/usage/i);
        await expect(runManualPayout(['approve', 'd1', 'x'], fake(row()).deps)).rejects.toThrow(/position/);
    });
});
