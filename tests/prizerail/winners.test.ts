import { describe, expect, test } from 'bun:test';
import { formatWinnersAlert, planWinnerRecords, splitDiscordMessage } from '../../src/prizerail/winners';
import type { PrizerailDrawing } from '../../src/prizerail/types';

const drawing: PrizerailDrawing = {
    id: 'd9',
    number: 12,
    kind: 'regular',
    drawAt: '2026-11-03T17:00:00Z',
    cutoffAt: '2026-11-03T16:30:00Z',
    status: 'paid',
    winnersExpected: 3,
    winners: [
        { position: 1, winner: 'ent-a', amountCents: 1500, heldForManualPayout: false },
        { position: 2, winner: 'ent-b', amountCents: 100000, heldForManualPayout: true },
        { position: 3, winner: 'ent-unknown', amountCents: 1000, heldForManualPayout: false },
    ],
};

const wallets: Record<string, string> = {
    'ent-a': '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'ent-b': '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
};

const resolve = (id: string) => wallets[id] ?? null;

describe('planWinnerRecords', () => {
    test('builds one record per winner with the resolved wallet', () => {
        const records = planWinnerRecords(drawing, resolve, 1_000);
        expect(records).toHaveLength(3);
        expect(records[0]).toMatchObject({
            drawingId: 'd9',
            drawingNumber: 12,
            position: 1,
            entrantId: 'ent-a',
            wallet: wallets['ent-a'],
            amountCents: 1500,
            heldForManualPayout: false,
            drawingStatus: 'paid',
            payoutStatus: 'pending',
            recordedAt: 1_000,
        });
    });

    test('marks unresolved entrants so an operator can investigate', () => {
        const unknown = planWinnerRecords(drawing, resolve, 1).find((r) => r.position === 3);
        expect(unknown?.wallet).toBeNull();
        expect(unknown?.payoutStatus).toBe('unresolved_entrant');
    });

    test('does not mutate the input drawing', () => {
        const before = JSON.stringify(drawing);
        planWinnerRecords(drawing, () => null, 1);
        expect(JSON.stringify(drawing)).toBe(before);
    });
});

describe('formatWinnersAlert', () => {
    test('lists full wallet, amount, held and unresolved flags per winner', () => {
        const records = planWinnerRecords(drawing, resolve, 1);
        const msg = formatWinnersAlert('p2p-daily', drawing, records);
        expect(msg).toContain('p2p-daily');
        expect(msg).toContain('#12');
        expect(msg).toContain('$15.00');
        expect(msg).toContain('$1,000.00');
        expect(msg).toContain('held');
        expect(msg).toContain('unresolved');
        expect(msg).toContain(wallets['ent-a']);
        expect(msg).not.toContain('…');
    });
});

describe('splitDiscordMessage', () => {
    test('returns a single chunk when under the limit', () => {
        expect(splitDiscordMessage('a\nb', 100)).toEqual(['a\nb']);
    });

    test('splits on newlines without exceeding the limit', () => {
        const lines = Array.from({ length: 50 }, (_, i) => `line-${i}-${'x'.repeat(40)}`);
        const chunks = splitDiscordMessage(lines.join('\n'), 300);
        expect(chunks.length).toBeGreaterThan(1);
        for (const c of chunks) expect(c.length).toBeLessThanOrEqual(300);
        expect(chunks.join('\n')).toBe(lines.join('\n'));
    });

    test('hard-splits a single oversized line', () => {
        const chunks = splitDiscordMessage('y'.repeat(650), 300);
        expect(chunks.map((c) => c.length)).toEqual([300, 300, 50]);
    });
});
