// Minimal ABI for the R8 dispute ladder on the MAIN Diamond (OrderProcessorFacet):
// only what the dispute finalize keeper needs.
//
// From R8 a tier-1 (circle) or tier-2 (country Admin) decision does NOT settle
// the order. It emits DisputeDecided and waits out the currency's appeal window
// (default 24h); after that anyone may call finalizeDispute(orderId) to execute
// it (refund or completion, plus the B2B callback). There is no caller
// allow-list, so the Keeper wallet needs only ETH for gas. A tier-3 decision
// settles in the same tx and is emitted with appealableUntil = 0.
export const DISPUTE_ABI = [
    'event DisputeDecided(uint256 indexed orderId, uint8 decisionTier, uint8 faultType, address indexed by, uint64 appealableUntil)',
    // All zero when no decision is pending: finalized, appealed, or overridden at
    // tier 3. appealableUntil is computed from the CURRENT per-currency window, so
    // it is the deadline to trust; the event's copy goes stale if the window changes.
    'function getDisputeDecision(uint256 orderId) view returns (uint8 faultType, uint8 decisionTier, address decidedBy, uint64 decidedAt, uint64 appealableUntil)',
    // Permissionless. Reverts DisputeNotRaised / NoDisputeDecision /
    // DisputeAppealWindowOpen, all caught in presim at 0 gas.
    'function finalizeDispute(uint256 orderId)',
    'error DisputeNotRaised()',
    'error NoDisputeDecision()',
    'error DisputeAppealWindowOpen()',
] as const;
