import { describe, expect, test } from 'bun:test';
import { entrantIdFor, entriesForOrder, MAX_ENTRIES } from '../../src/prizerail/entries';

const KEY = 'test-hmac-key-with-enough-length';
const ADDR = '0xAbCdEf0000000000000000000000000000000001';

describe('entrantIdFor', () => {
    test('is deterministic for the same address and key', () => {
        expect(entrantIdFor(ADDR, KEY)).toBe(entrantIdFor(ADDR, KEY));
    });

    test('is case-insensitive on the address', () => {
        expect(entrantIdFor(ADDR, KEY)).toBe(entrantIdFor(ADDR.toLowerCase(), KEY));
    });

    test('changes with the key', () => {
        expect(entrantIdFor(ADDR, KEY)).not.toBe(entrantIdFor(ADDR, `${KEY}-2`));
    });

    test('does not leak the address and fits Prizerail limit', () => {
        const id = entrantIdFor(ADDR, KEY);
        expect(id).toMatch(/^[0-9a-f]{64}$/);
        expect(id.toLowerCase()).not.toContain(ADDR.slice(2, 12).toLowerCase());
        expect(id.length).toBeLessThanOrEqual(200);
    });
});

describe('entriesForOrder', () => {
    test('one entry per whole USDC at the 2% default rate', () => {
        expect(entriesForOrder(50_000_000n, 200)).toBe(50);
        expect(entriesForOrder(1_000_000n, 200)).toBe(1);
    });

    test('scales with the market rate', () => {
        expect(entriesForOrder(50_000_000n, 100)).toBe(25); // ARS / MEX at 1%
        expect(entriesForOrder(50_000_000n, 400)).toBe(100);
        expect(entriesForOrder(50_000_000n, 0)).toBe(0);
    });

    test('floors fractional entries', () => {
        expect(entriesForOrder(1_999_999n, 200)).toBe(1);
        expect(entriesForOrder(999_999n, 200)).toBe(0);
        expect(entriesForOrder(3_000_000n, 100)).toBe(1); // 1.5 → 1
    });

    test('zero, negative and bad rates yield zero', () => {
        expect(entriesForOrder(0n, 200)).toBe(0);
        expect(entriesForOrder(-5n, 200)).toBe(0);
        expect(entriesForOrder(5_000_000n, -1)).toBe(0);
        expect(entriesForOrder(5_000_000n, 2.5)).toBe(0);
    });

    test('caps at the Prizerail uint32 maximum', () => {
        const huge = BigInt(MAX_ENTRIES) * 1_000_000n * 10n;
        expect(entriesForOrder(huge, 200)).toBe(MAX_ENTRIES);
    });
});
