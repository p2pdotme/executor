import { describe, expect, test } from 'bun:test';
import { entrantIdFor, entriesFromCashbackUsdc, MAX_ENTRIES } from './entries';

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

describe('entriesFromCashbackUsdc', () => {
    test('one entry per cent of cashback', () => {
        // 2.50 USDC in 6-dec = 2_500_000 → 250 cents
        expect(entriesFromCashbackUsdc(2_500_000n)).toBe(250);
    });

    test('floors sub-cent amounts', () => {
        expect(entriesFromCashbackUsdc(19_999n)).toBe(1);
        expect(entriesFromCashbackUsdc(9_999n)).toBe(0);
    });

    test('zero and negative yield zero', () => {
        expect(entriesFromCashbackUsdc(0n)).toBe(0);
        expect(entriesFromCashbackUsdc(-5n)).toBe(0);
    });

    test('caps at the Prizerail uint32 maximum', () => {
        const huge = BigInt(MAX_ENTRIES) * 10_000n * 10n;
        expect(entriesFromCashbackUsdc(huge)).toBe(MAX_ENTRIES);
    });
});
