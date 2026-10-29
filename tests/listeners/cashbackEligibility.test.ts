import { describe, expect, test } from 'bun:test';
import { encodeBytes32String } from 'ethers';
import { anyRatePositive, computeCashback, decodeCurrency, resolveCashbackBps } from '../../src/listeners/cashbackEligibility';

describe('decodeCurrency', () => {
    test('decodes a bytes32 symbol and upper-cases it', () => {
        expect(decodeCurrency(encodeBytes32String('ars'))).toBe('ARS');
    });

    test('returns empty on unset or invalid input', () => {
        expect(decodeCurrency('')).toBe('');
        expect(decodeCurrency(undefined)).toBe('');
        expect(decodeCurrency('0x1234')).toBe('');
    });
});

describe('resolveCashbackBps', () => {
    const rates = { cashbackBps: 200, cashbackBpsByCurrency: { ARS: 100, VEN: 0 } };

    test('prefers the per-currency override', () => {
        expect(resolveCashbackBps(rates, 'ARS')).toBe(100);
        expect(resolveCashbackBps(rates, 'VEN')).toBe(0);
    });

    test('falls back to the default', () => {
        expect(resolveCashbackBps(rates, 'NGN')).toBe(200);
        expect(resolveCashbackBps(rates, '')).toBe(200);
    });
});

describe('anyRatePositive', () => {
    test('true when the default or any override is positive', () => {
        expect(anyRatePositive({ cashbackBps: 200, cashbackBpsByCurrency: {} })).toBe(true);
        expect(anyRatePositive({ cashbackBps: 0, cashbackBpsByCurrency: { ARS: 100 } })).toBe(true);
    });

    test('false when every rate is zero', () => {
        expect(anyRatePositive({ cashbackBps: 0, cashbackBpsByCurrency: { ARS: 0 } })).toBe(false);
        expect(anyRatePositive({ cashbackBps: 0, cashbackBpsByCurrency: {} })).toBe(false);
    });
});

describe('computeCashback', () => {
    test('applies bps with integer division', () => {
        expect(computeCashback(1_000_000n, 200)).toBe(20_000n);
        expect(computeCashback(49n, 200)).toBe(0n);
    });
});
