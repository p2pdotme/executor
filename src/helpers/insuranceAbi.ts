// Minimal ABI for the Insurance Diamond — only the pieces the settle keeper
// needs: the ClaimApproved event (WS trigger) and the settleClaim write.
//
// settleClaim is NOT permissionless: on-chain it requires msg.sender to be the
// claimant / beneficiary / a currency approver / a super admin / a circle
// delegate. The Keeper wallet must therefore be whitelisted as a currency
// approver (setCurrencyApprover) or granted super-admin rights, or every settle
// staticCall reverts NotAuthorized (caught in presim at 0 gas).
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
    // Reverts InsuranceClaimNotFound / InsuranceInvalidClaimStatus /
    // InsurancePayoutDelayNotMet / NotAuthorized — all caught in presim (0 gas)
    // so a stale or not-yet-due claimId never wastes gas.
    {
        inputs: [{ internalType: 'uint256', name: 'claimId', type: 'uint256' }],
        name: 'settleClaim',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
    },
] as const;

export const INSURANCE_ABI = [...INSURANCE_EVENTS, ...INSURANCE_FUNCTIONS] as const;
