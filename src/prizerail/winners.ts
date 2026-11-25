import type { PrizerailDrawing } from './types';

import type { PayoutStatus } from './payout';
import { planRelease } from './release';

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
    // Prizerail's "share your win" step for this winner (see release.ts).
    publicityRequired: boolean;
    publicityStatus: string | null;
    // The winner's private share link, for the app to show them.
    publicityUrl: string | null;
    // Prizerail's transfer to the prize wallet that funds this prize.
    fundingKind: string | null;
    fundingStatus: string | null;
    fundingTxHash: string | null;
    // Why the prize must not be paid yet; null once Prizerail released it.
    releaseBlocked: string | null;
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
        const release = planRelease(drawing, w);
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
            publicityRequired: release.publicityRequired,
            publicityStatus: release.publicityStatus,
            publicityUrl: release.publicityUrl,
            fundingKind: release.fundingKind,
            fundingStatus: release.fundingStatus,
            fundingTxHash: release.fundingTxHash,
            releaseBlocked: release.blocked,
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
            r.releaseBlocked,
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

/** A prize Prizerail was holding has been released: say what happens next. */
export function formatReleaseAlert(r: WinnerRecord, payoutStatus: string, payoutEnabled: boolean): string {
    const funding = r.fundingTxHash ? `, ${r.fundingKind ?? 'transfer'} \`${r.fundingTxHash}\` confirmed` : '';
    const share = r.publicityRequired ? 'winner share approved' : 'no share required';
    const head = `🎟️ Prize released by Prizerail: ${formatUsd(r.amountCents)} → \`${r.wallet ?? r.entrantId}\` (draw ${r.drawingId} #${r.position}) — ${share}${funding}.`;
    if (payoutStatus === 'pending') {
        return `${head} ${payoutEnabled ? 'Paying it now.' : 'Automatic payout is off: pay it by hand and mark-paid.'}`;
    }
    if (payoutStatus === 'held') {
        return `${head} Over the auto-pay cap: run \`prizerail:payout approve ${r.drawingId} ${r.position}\` to pay it from the prize wallet.`;
    }
    return `${head} Row is ${payoutStatus}: see \`prizerail:payout list\`.`;
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
