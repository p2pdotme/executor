// Pure payout policy. The worker decides nothing on its own: a winner row is
// either queued for an automatic USDC transfer or parked for a human, and
// the reason is written next to it.

export type PayoutStatus =
    | 'pending' // resolved wallet, under the cap: the worker may pay it
    | 'unresolved_entrant' // no wallet for the entrant id (map missing)
    | 'held' // needs a human: Prizerail hold, over the cap, zero amount
    | 'paying' // claimed by the worker; a transfer may be in flight
    | 'paid' // confirmed on-chain, tx_hash set
    | 'manual' // sent but unconfirmed/reverted: verify on-chain by hand
    | 'failed'; // never sent (presim/send failed), see last_error

export type PayoutDecision = {
    status: 'pending' | 'unresolved_entrant' | 'held';
    reason: string | null;
};

export type PayoutCandidate = {
    wallet: string | null;
    amountCents: number;
    heldForManualPayout: boolean;
};

// USDC has 6 decimals; one US cent is 10^4 base units.
const USDC_UNITS_PER_CENT = 10_000n;

/**
 * Classify a winner for payout. `maxAutoPayoutCents` is the ceiling for an
 * unattended transfer: at or above it the prize stays with a human, which
 * also lines up with Prizerail's identity check for winners crossing the
 * large-prize threshold (default $600). A cap of 0 disables auto-payout.
 */
export function planPayout(candidate: PayoutCandidate, maxAutoPayoutCents: number): PayoutDecision {
    if (!candidate.wallet) {
        return { status: 'unresolved_entrant', reason: 'no wallet for entrant id' };
    }
    if (candidate.heldForManualPayout) {
        return { status: 'held', reason: 'held by Prizerail for review' };
    }
    if (!Number.isInteger(candidate.amountCents) || candidate.amountCents <= 0) {
        return { status: 'held', reason: 'non-positive amount' };
    }
    if (candidate.amountCents >= maxAutoPayoutCents) {
        return {
            status: 'held',
            reason: `amount ${candidate.amountCents}c at or above auto-payout cap ${maxAutoPayoutCents}c`,
        };
    }
    return { status: 'pending', reason: null };
}

export function centsToUsdc6(cents: number): bigint {
    if (!Number.isInteger(cents) || cents < 0) {
        throw new Error(`centsToUsdc6: expected a non-negative integer, got ${cents}`);
    }
    return BigInt(cents) * USDC_UNITS_PER_CENT;
}

export const ERC20_ABI = [
    {
        inputs: [
            { internalType: 'address', name: 'to', type: 'address' },
            { internalType: 'uint256', name: 'amount', type: 'uint256' },
        ],
        name: 'transfer',
        outputs: [{ internalType: 'bool', name: '', type: 'bool' }],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    {
        inputs: [{ internalType: 'address', name: 'account', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [],
        name: 'decimals',
        outputs: [{ internalType: 'uint8', name: '', type: 'uint8' }],
        stateMutability: 'view',
        type: 'function',
    },
] as const;
