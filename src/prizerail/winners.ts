import type { PrizerailDrawing } from './types';

import type { PayoutStatus } from './payout';

// The planned status at discovery time; the ledger refines it (held, paying,
// paid, …) — see prizerail/payout.ts.
export type WinnerPayoutStatus = Extract<PayoutStatus, 'pending' | 'unresolved_entrant'>;

export type WinnerRecord = {
    drawingId: string;
    drawingNumber: number | null;
    drawingKind: string;
    drawingStatus: string;
    drawAt: string;
    position: number;
    entrantId: string;
    wallet: string | null;
    amountCents: number;
    heldForManualPayout: boolean;
    payoutStatus: WinnerPayoutStatus;
    recordedAt: number;
};

export type ResolveWallet = (entrantId: string) => string | null;

// Discord rejects content over 2000 characters; leave headroom.
export const DISCORD_MESSAGE_LIMIT = 1_900;

/**
 * Pure: turn a settled/paid drawing into one ledger record per winner. The
 * resolver maps Prizerail's pseudonymous entrant id back to the wallet we
 * stored when the entry was sent; a miss is recorded (not dropped) so an
 * operator sees it.
 */
export function planWinnerRecords(
    drawing: PrizerailDrawing,
    resolveWallet: ResolveWallet,
    recordedAt: number,
): WinnerRecord[] {
    return drawing.winners.map((w) => {
        const wallet = resolveWallet(w.winner);
        return {
            drawingId: drawing.id,
            drawingNumber: drawing.number ?? null,
            drawingKind: drawing.kind,
            drawingStatus: drawing.status,
            drawAt: drawing.drawAt,
            position: w.position,
            entrantId: w.winner,
            wallet,
            amountCents: w.amountCents,
            heldForManualPayout: w.heldForManualPayout,
            payoutStatus: wallet ? 'pending' : 'unresolved_entrant',
            recordedAt,
        };
    });
}

export function formatUsd(cents: number): string {
    return `$${(cents / 100).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    })}`;
}

export function formatWinnersAlert(
    campaignSlug: string,
    drawing: PrizerailDrawing,
    records: readonly WinnerRecord[],
): string {
    const total = records.reduce((sum, r) => sum + r.amountCents, 0);
    const label = drawing.number === null || drawing.number === undefined ? drawing.id : `#${drawing.number}`;
    const lines = records.map((r) => {
        const flags = [
            r.heldForManualPayout ? 'held by Prizerail' : null,
            r.wallet ? null : 'unresolved entrant',
        ].filter(Boolean);
        const suffix = flags.length ? ` (${flags.join(', ')})` : '';
        return `• #${r.position} ${formatUsd(r.amountCents)} → \`${r.wallet ?? r.entrantId}\`${suffix}`;
    });
    return [
        `🎟️ Prizerail ${campaignSlug} draw ${label} (${drawing.kind}, ${drawing.status}) — ${records.length} winner(s), ${formatUsd(total)} total`,
        `drawAt: ${drawing.drawAt} · drawingId: ${drawing.id}`,
        ...lines,
    ].join('\n');
}

/** Split a message on newlines into chunks that each fit the Discord limit. */
export function splitDiscordMessage(message: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
    const chunks: string[] = [];
    let current = '';
    for (const rawLine of message.split('\n')) {
        for (const line of hardSplit(rawLine, limit)) {
            const candidate = current ? `${current}\n${line}` : line;
            if (candidate.length <= limit) {
                current = candidate;
            } else {
                if (current) chunks.push(current);
                current = line;
            }
        }
    }
    if (current) chunks.push(current);
    return chunks;
}

function hardSplit(line: string, limit: number): string[] {
    if (line.length <= limit) return [line];
    const parts: string[] = [];
    for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
    return parts;
}
