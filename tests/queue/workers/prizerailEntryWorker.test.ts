import { describe, expect, test } from 'bun:test';
import { eventIdForOrder, shouldSkipForDryRun } from '../../../src/queue/workers/prizerailEntryWorker';

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
