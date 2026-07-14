// Minimal ABI for the Insurance Diamond — only the pieces the settle keeper
// needs: the ClaimApproved event (WS trigger) and the settleClaimPermissionless
// write.
//
// settleClaimPermissionless can be called by anyone once a claim is APPROVED and
// its payout delay has elapsed (it drops the caller allow-list that gates the
// authorised {settleClaim}). So the Keeper wallet needs NO on-chain whitelist —
// just ETH for gas. Settlement is deterministic: funds always go to the claim's
// pre-recorded beneficiary.
export const INSURANCE_EVENTS = [
    {
        anonymous: false,
        inputs: [
            { indexed: true, internalType: 'uint256', name: 'claimId', type: 'uint256' },
            { indexed: true, internalType: 'uint256', name: 'circleId', type: 'uint256' },
            { indexed: true, internalType: 'address', name: 'resolver', type: 'address' },
            { indexed: false, internalType: 'uint256', name: 'payoutEligibleAt', type: 'uint256' },
        ],
        name: 'ClaimApproved',
        type: 'event',
    },
] as const;

export const INSURANCE_FUNCTIONS = [
    // Permissionless. Reverts InsuranceClaimNotFound / InsuranceInvalidClaimStatus /
    // InsurancePayoutDelayNotMet / InsuranceInsufficientFunds — all caught in
    // presim (0 gas) so a stale, not-yet-due, or underfunded claimId never
    // wastes gas.
    {
        inputs: [{ internalType: 'uint256', name: 'claimId', type: 'uint256' }],
        name: 'settleClaimPermissionless',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
    },
] as const;

export const INSURANCE_ABI = [...INSURANCE_EVENTS, ...INSURANCE_FUNCTIONS] as const;
