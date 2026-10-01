// Minimal ABI for the Insurance Diamond — only the pieces the settle keeper
// needs: the ClaimApproved event (WS trigger), the settleClaim write and the
// getClaimContest read.
//
// settleClaim is permissionless — anyone can call it once a claim is APPROVED,
// uncontested, and past its contest window (there is no caller allow-list). So the
// Keeper wallet needs NO on-chain whitelist — just ETH for gas. Settlement is
// deterministic: funds always go to the claim's pre-recorded beneficiary.
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
    // InsuranceClaimContested / InsurancePayoutDelayNotMet /
    // InsuranceInsufficientFunds — all caught in presim (0 gas) so a stale,
    // contested, not-yet-due, or underfunded claimId never wastes gas.
    {
        inputs: [{ internalType: 'uint256', name: 'claimId', type: 'uint256' }],
        name: 'settleClaim',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    // R6 contest state. `eligibleAt` is the LIVE window end — removeContest
    // restarts it, so it can be later than the ClaimApproved payoutEligibleAt
    // the subgraph (and our delayed job) still carry. 0 for a claim approved
    // before R6, which keeps the legacy payoutDelay gate.
    {
        inputs: [{ internalType: 'uint256', name: 'claimId', type: 'uint256' }],
        name: 'getClaimContest',
        outputs: [
            { internalType: 'bool', name: 'contested', type: 'bool' },
            { internalType: 'uint64', name: 'eligibleAt', type: 'uint64' },
            { internalType: 'address', name: 'contestedBy', type: 'address' },
        ],
        stateMutability: 'view',
        type: 'function',
    },
] as const;

export const INSURANCE_ABI = [...INSURANCE_EVENTS, ...INSURANCE_FUNCTIONS] as const;
