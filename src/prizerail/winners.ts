import type { PrizerailDrawing } from './types';

// Where a winner's payout stands from OUR side. Prizerail pays the prize USDC
// to the campaign wallet; paying the user is our job and is not automated
// yet (see README → Prizerail). Every record therefore starts pending_manual.
export type WinnerPayoutStatus = 'pending_manual' | 'unresolved_entrant';

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
            payoutStatus: wallet ? 'pending_manual' : 'unresolved_entrant',
            recordedAt,
        };
    });
}

// Redis hashes hold strings only; null becomes ''.
export function flattenRecord(record: WinnerRecord): Record<string, string> {
    return Object.fromEntries(
        Object.entries(record).map(([k, v]) => [k, v === null ? '' : String(v)]),
    );
}

export type MergeResult = {
    // Fields to write back, or null when storage is already current.
    patch: Record<string, string> | null;
    // The record as it stands after the merge (what to alert on).
    effective: WinnerRecord;
};

/**
 * Pure: reconcile a stored winner record with a freshly planned one. Only two
 * things may change after first write — the drawing's status (settled →
 * paid) and a wallet that was unresolved but can be resolved now. A stored
 * wallet is never cleared, and the original recordedAt is kept.
 */
export function mergeWinnerRecord(existing: Record<string, string>, planned: WinnerRecord): MergeResult {
    const storedWallet = existing.wallet ? existing.wallet : null;
    const wallet = storedWallet ?? planned.wallet;
    const payoutStatus: WinnerPayoutStatus = wallet ? 'pending_manual' : 'unresolved_entrant';
    const recordedAt = Number.isFinite(Number(existing.recordedAt)) && existing.recordedAt !== ''
        ? Number(existing.recordedAt)
        : planned.recordedAt;

    const patch: Record<string, string> = {};
    if (existing.drawingStatus !== planned.drawingStatus) patch.drawingStatus = planned.drawingStatus;
    if (!storedWallet && wallet) {
        patch.wallet = wallet;
        patch.payoutStatus = payoutStatus;
    }

    return {
        patch: Object.keys(patch).length ? patch : null,
        effective: { ...planned, wallet, payoutStatus, recordedAt },
    };
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
        'Payouts to users are manual until the payout rail is enabled.',
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
