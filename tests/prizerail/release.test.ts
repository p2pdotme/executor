import { describe, expect, test } from 'bun:test';
import { planRelease } from '../../src/prizerail/release';
import type { PrizerailDrawing, PrizerailPayout, PrizerailWinner } from '../../src/prizerail/types';

const winner = (over: Partial<PrizerailWinner> = {}): PrizerailWinner => ({
    position: 0,
    winner: 'ent-a',
    amountCents: 1500,
    heldForManualPayout: false,
    publicity: { required: false, status: null, url: null },
    ...over,
});

const payout = (over: Partial<PrizerailPayout> = {}): PrizerailPayout => ({
    id: 'p1',
    kind: 'lump_sum',
    amountCents: 1500,
    status: 'confirmed',
    txHash: '0xlump',
    winnerPosition: null,
    ...over,
});

const drawing = (winners: PrizerailWinner[], payouts: PrizerailPayout[], status = 'settled'): PrizerailDrawing => ({
    id: 'd1',
    number: 1,
    kind: 'guarantee',
    drawAt: '2026-11-25T16:15:00Z',
    status,
    winners,
    payouts,
});

const SHARE_URL = 'https://prizerail.test/share/abc';
const big = (publicity: PrizerailWinner['publicity']) => winner({ amountCents: 100_000, heldForManualPayout: true, publicity });
const ownTransfer = (status: string, kind = 'publicity_prize') =>
    payout({ id: 'p2', kind, amountCents: 100_000, status, txHash: status === 'confirmed' ? '0xprize' : null, winnerPosition: 0 });

describe('planRelease — ordinary prizes ride the lump sum', () => {
    test('released once the lump sum is confirmed', () => {
        const w = winner();
        expect(planRelease(drawing([w], [payout()]), w)).toMatchObject({
            blocked: null,
            fundingKind: 'lump_sum',
            fundingStatus: 'confirmed',
            fundingTxHash: '0xlump',
            publicityRequired: false,
        });
    });

    test.each(['pending', 'submitted', 'failed'])('blocked while the lump sum is %s', (status) => {
        const w = winner();
        expect(planRelease(drawing([w], [payout({ status, txHash: null })]), w).blocked).toBe(`awaiting Prizerail lump_sum transfer (${status})`);
    });

    test('no transfer row yet: blocked while settled, released once the drawing is paid', () => {
        const w = winner();
        expect(planRelease(drawing([w], []), w).blocked).toMatch(/lump_sum transfer \(not created yet\)/);
        expect(planRelease(drawing([w], [], 'paid'), w).blocked).toBeNull();
    });

    test.each([undefined, null])('a winner with no publicity block (%s) is never paid', (publicity) => {
        const w = winner({ publicity });
        expect(planRelease(drawing([w], [payout()], 'paid'), w).blocked).toMatch(/publicity state missing/);
    });
});

describe('planRelease — the $1,000 guaranteed prize', () => {
    test('blocked until the winner shares, and the share link is carried', () => {
        const w = big({ required: true, status: 'awaiting', url: SHARE_URL });
        const plan = planRelease(drawing([w], [ownTransfer('held_publicity')]), w);
        expect(plan.blocked).toBe('awaiting winner share (publicity awaiting)');
        expect(plan).toMatchObject({ publicityRequired: true, publicityStatus: 'awaiting', publicityUrl: SHARE_URL, fundingKind: 'publicity_prize' });
    });

    test.each(['in_review', 'rejected', null])('publicity %s is not approved', (status) => {
        const w = big({ required: true, status, url: SHARE_URL });
        expect(planRelease(drawing([w], [ownTransfer('held_publicity')]), w).blocked).toMatch(/awaiting winner share/);
    });

    test('share approved but its own transfer not confirmed yet: still blocked', () => {
        const w = big({ required: true, status: 'approved', url: null });
        expect(planRelease(drawing([w], [ownTransfer('submitted')]), w).blocked).toBe('awaiting Prizerail publicity_prize transfer (submitted)');
    });

    test('share approved and its own transfer confirmed: released', () => {
        const w = big({ required: true, status: 'approved', url: null });
        expect(planRelease(drawing([w], [ownTransfer('confirmed')]), w)).toMatchObject({
            blocked: null,
            fundingKind: 'publicity_prize',
            fundingTxHash: '0xprize',
        });
    });

    test('a confirmed transfer never overrides an unapproved share', () => {
        const w = big({ required: true, status: 'awaiting', url: SHARE_URL });
        expect(planRelease(drawing([w], [ownTransfer('confirmed')]), w).blocked).toMatch(/awaiting winner share/);
    });

    test('a confirmed lump sum never funds a held prize', () => {
        const small = winner({ position: 1 });
        const w = big({ required: true, status: 'approved', url: null });
        const d = drawing([w, small], [payout()]); // only the lump sum exists so far
        expect(planRelease(d, w).blocked).toMatch(/transfer for this held prize \(not created yet\)/);
        expect(planRelease(d, w).fundingKind).toBeNull();
        expect(planRelease(d, small).blocked).toBeNull(); // the small prize still pays
    });

    test('a held prize with no transfer row of its own stays blocked even on a paid drawing', () => {
        const w = big({ required: true, status: 'approved', url: null });
        expect(planRelease(drawing([w], [payout()], 'paid'), w).blocked).toMatch(/held prize \(not created yet\)/);
    });

    test('a large prize with no share step waits for its own large_prize transfer', () => {
        const w = big({ required: false, status: null, url: null });
        expect(planRelease(drawing([w], [ownTransfer('held_manual', 'large_prize')]), w).blocked).toBe('awaiting Prizerail large_prize transfer (held_manual)');
        expect(planRelease(drawing([w], [ownTransfer('confirmed', 'large_prize')]), w).blocked).toBeNull();
    });

    test('a direct payout row is not money sent to us', () => {
        const w = big({ required: false, status: null, url: null });
        const direct = payout({ kind: 'direct', status: 'confirmed', winnerPosition: 0 });
        expect(planRelease(drawing([w], [direct]), w).blocked).toMatch(/not created yet/);
    });

    test('does not mutate its inputs', () => {
        const w = big({ required: true, status: 'awaiting', url: SHARE_URL });
        const d = drawing([w], [ownTransfer('held_publicity')]);
        const before = JSON.stringify(d);
        planRelease(d, w);
        expect(JSON.stringify(d)).toBe(before);
    });
});
