import { describe, expect, test } from 'bun:test';
import { formatReleaseAlert, formatWinnersAlert, planWinnerRecords, splitDiscordMessage } from '../../src/prizerail/winners';
import type { PrizerailDrawing } from '../../src/prizerail/types';

const drawing: PrizerailDrawing = {
    id: 'd9',
    number: 12,
    kind: 'regular',
    drawAt: '2026-11-03T17:00:00Z',
    cutoffAt: '2026-11-03T16:30:00Z',
    status: 'settled',
    winnersExpected: 3,
    winners: [
        { position: 1, winner: 'ent-a', amountCents: 1500, heldForManualPayout: false, publicity: { required: false, status: null, url: null } },
        {
            position: 2,
            winner: 'ent-b',
            amountCents: 100000,
            heldForManualPayout: true,
            publicity: { required: true, status: 'awaiting', url: 'https://prizerail.test/share/abc' },
        },
        { position: 3, winner: 'ent-unknown', amountCents: 1000, heldForManualPayout: false, publicity: { required: false, status: null, url: null } },
    ],
    payouts: [
        { id: 'p1', kind: 'lump_sum', amountCents: 2500, status: 'confirmed', txHash: '0xlump', winnerPosition: null },
        { id: 'p2', kind: 'publicity_prize', amountCents: 100000, status: 'held_publicity', txHash: null, winnerPosition: 2 },
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
            drawingStatus: 'settled',
            payoutStatus: 'pending',
            releaseBlocked: null,
            fundingKind: 'lump_sum',
            fundingTxHash: '0xlump',
            recordedAt: 1_000,
        });
    });

    test('carries the share link and the block for a prize Prizerail is holding', () => {
        const held = planWinnerRecords(drawing, resolve, 1).find((r) => r.position === 2);
        expect(held).toMatchObject({
            publicityRequired: true,
            publicityStatus: 'awaiting',
            publicityUrl: 'https://prizerail.test/share/abc',
            fundingKind: 'publicity_prize',
            fundingStatus: 'held_publicity',
        });
        expect(held?.releaseBlocked).toMatch(/awaiting winner share/);
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
        expect(msg).toContain('awaiting winner share');
        expect(msg).not.toContain('prizerail.test/share'); // the private link stays out of Discord
        expect(msg).toContain('unresolved');
        expect(msg).toContain(wallets['ent-a']);
        expect(msg).not.toContain('…');
    });
});

describe('formatReleaseAlert', () => {
    const released = {
        ...planWinnerRecords(drawing, resolve, 1)[1],
        publicityStatus: 'approved',
        fundingStatus: 'confirmed',
        fundingTxHash: '0xprize',
        releaseBlocked: null,
    };

    test('an over-cap prize tells the operator the exact approve command', () => {
        const msg = formatReleaseAlert(released, 'held', true);
        expect(msg).toContain('$1,000.00');
        expect(msg).toContain('winner share approved');
        expect(msg).toContain('0xprize');
        expect(msg).toContain('prizerail:payout approve d9 2');
    });

    test('a pending prize is announced as being paid, or by hand when payout is off', () => {
        expect(formatReleaseAlert(released, 'pending', true)).toContain('Paying it now');
        expect(formatReleaseAlert(released, 'pending', false)).toContain('by hand');
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
