import { describe, expect, test } from 'bun:test';
import { eventIdForOrder, shouldSkipForDryRun } from '../../../src/queue/workers/prizerailEntryWorker';
import { formatEntryAlert } from '../../../src/prizerail/entries';

describe('eventIdForOrder', () => {
    test('namespaces the order id', () => {
        expect(eventIdForOrder('42')).toBe('order-42');
    });
});

describe('shouldSkipForDryRun', () => {
    test('never skips against the sandbox', () => {
        expect(shouldSkipForDryRun(true, true)).toBe(false);
        expect(shouldSkipForDryRun(false, true)).toBe(false);
    });

    test('skips only when dry-running with a production key', () => {
        expect(shouldSkipForDryRun(true, false)).toBe(true);
        expect(shouldSkipForDryRun(false, false)).toBe(false);
    });
});

describe('formatEntryAlert', () => {
    test('shows the order, its USDC value, country and entries', () => {
        expect(formatEntryAlert({ orderId: '829761', entries: 301, amountUsdc: '301000000', currency: 'BRL' })).toBe(
            '🎟️ Prizerail entries: order 829761 · 301.00 USDC · Brazil (BRL) · 301 entries',
        );
    });

    test('shows the code alone when it is not one country', () => {
        expect(formatEntryAlert({ orderId: '1', entries: 5, amountUsdc: '5993956', currency: 'USD' })).toBe(
            '🎟️ Prizerail entries: order 1 · 5.99 USDC · USD · 5 entries',
        );
    });

    test('a job queued before the alert fields existed still formats', () => {
        expect(formatEntryAlert({ orderId: '2', entries: 1 })).toBe('🎟️ Prizerail entries: order 2 · value n/a · n/a · 1 entries');
    });
});
