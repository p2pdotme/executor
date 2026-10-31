import { describe, expect, test } from 'bun:test';
import { centsToUsdc6, planPayout } from '../../src/prizerail/payout';

const base = {
    wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    amountCents: 1500,
    heldForManualPayout: false,
};

describe('planPayout', () => {
    test('pays a resolved, unheld prize under the cap', () => {
        expect(planPayout(base, 60_000)).toEqual({ status: 'pending', reason: null });
    });

    test('keeps an unresolved entrant out of the payout queue', () => {
        expect(planPayout({ ...base, wallet: null }, 60_000)).toEqual({
            status: 'unresolved_entrant',
            reason: 'no wallet for entrant id',
        });
    });

    test('holds a prize Prizerail itself is holding for review', () => {
        const d = planPayout({ ...base, heldForManualPayout: true }, 60_000);
        expect(d.status).toBe('held');
        expect(d.reason).toMatch(/prizerail/i);
    });

    test('pays a prize up to the cap and holds anything above it', () => {
        expect(planPayout({ ...base, amountCents: 10_000 }, 10_000).status).toBe('pending');
        expect(planPayout({ ...base, amountCents: 10_001 }, 10_000).status).toBe('held');
        expect(planPayout({ ...base, amountCents: 100_000 }, 10_000).reason).toMatch(/above auto-payout cap/);
    });

    test('a zero cap means nothing auto-pays', () => {
        expect(planPayout(base, 0).status).toBe('held');
    });

    test('a zero or negative amount is never paid', () => {
        expect(planPayout({ ...base, amountCents: 0 }, 60_000).status).toBe('held');
    });
});

describe('centsToUsdc6', () => {
    test('converts US cents to USDC base units', () => {
        expect(centsToUsdc6(1500)).toBe(15_000_000n);
        expect(centsToUsdc6(1)).toBe(10_000n);
    });

    test('rejects fractional or negative cents', () => {
        expect(() => centsToUsdc6(1.5)).toThrow();
        expect(() => centsToUsdc6(-1)).toThrow();
    });
});
