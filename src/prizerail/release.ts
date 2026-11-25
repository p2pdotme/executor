import type { PrizerailDrawing, PrizerailPayout, PrizerailWinner } from './types';

// Pure release gate. Prizerail pays prize USDC to the prize wallet and we pay
// the winner from it, so a prize may only leave once (a) the winner has
// completed the "share your win" step when Prizerail requires it, and (b) the
// Prizerail transfer that funds this exact prize is confirmed. Ordinary
// prizes are funded by the drawing's lump sum; a held prize (large prize, or
// one waiting on publicity) arrives as its own transfer carrying the winner's
// position and is never covered by the lump sum.
// https://docs.prizerail.com/integrations/pay-your-winners

export type ReleasePlan = {
    /** Why the prize must not be paid yet; null when Prizerail has released it. */
    blocked: string | null;
    publicityRequired: boolean;
    publicityStatus: string | null;
    publicityUrl: string | null;
    fundingKind: string | null;
    fundingStatus: string | null;
    fundingTxHash: string | null;
};

const PUBLICITY_APPROVED = 'approved';
const TRANSFER_CONFIRMED = 'confirmed';
const DRAWING_PAID = 'paid';
const KIND_LUMP_SUM = 'lump_sum';
// Paid by Prizerail straight to the winner; never money for us to forward.
const KIND_DIRECT = 'direct';

function fundingTransfer(drawing: PrizerailDrawing, winner: PrizerailWinner, needsOwnTransfer: boolean): PrizerailPayout | null {
    const partner = drawing.payouts.filter((p) => p.kind !== KIND_DIRECT);
    const own = partner.find((p) => p.winnerPosition === winner.position);
    if (own) return own;
    // A held prize is never paid out of the lump sum, even if its own row
    // has not been created yet.
    if (needsOwnTransfer) return null;
    return partner.find((p) => p.kind === KIND_LUMP_SUM) ?? null;
}

export function planRelease(drawing: PrizerailDrawing, winner: PrizerailWinner): ReleasePlan {
    const publicityRequired = winner.publicity?.required ?? false;
    const publicityStatus = winner.publicity?.status ?? null;
    const needsOwnTransfer = winner.heldForManualPayout || publicityRequired;
    const transfer = fundingTransfer(drawing, winner, needsOwnTransfer);

    const base = {
        publicityRequired,
        publicityStatus,
        publicityUrl: winner.publicity?.url ?? null,
        fundingKind: transfer?.kind ?? null,
        fundingStatus: transfer?.status ?? null,
        fundingTxHash: transfer?.txHash ?? null,
    };

    // Prizerail sends the publicity block on every winner. Without it we
    // cannot tell whether a share is owed, so nothing is paid.
    if (!winner.publicity) {
        return { ...base, blocked: 'publicity state missing from the Prizerail response' };
    }
    if (publicityRequired && publicityStatus !== PUBLICITY_APPROVED) {
        return { ...base, blocked: `awaiting winner share (publicity ${publicityStatus ?? 'not started'})` };
    }
    if (transfer) {
        if (transfer.status === TRANSFER_CONFIRMED) return { ...base, blocked: null };
        return { ...base, blocked: `awaiting Prizerail ${transfer.kind} transfer (${transfer.status})` };
    }
    // No transfer row to go by. A held prize always waits for its own row,
    // whatever the drawing says. For the rest, a 'paid' drawing means every
    // transfer is confirmed; anything earlier means nothing was sent yet.
    if (needsOwnTransfer) {
        return { ...base, blocked: 'awaiting Prizerail transfer for this held prize (not created yet)' };
    }
    if (drawing.status === DRAWING_PAID) return { ...base, blocked: null };
    return { ...base, blocked: 'awaiting Prizerail lump_sum transfer (not created yet)' };
}
