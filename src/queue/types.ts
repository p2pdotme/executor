// All job names the executor will handle
export type ContractJobName =
    | 'ToggleMerchantsOffline'
    | 'AssignMerchants'
    | 'GetOrdersById'
    | 'IssueCashbackCredit';

// Toggle-offline job payload
export type ToggleOfflineJobData = {
    orderId: string;
    circleId: string;
    currency: string; // bytes32 hex string
};

// Order-based job payload
export type OrderJobData = {
    orderId: string;
    txHash?: string;
};

// IssueCashbackCredit job payload — the BUY/SELL cashback programme handler
// (see queue/handlers.ts → issueCashbackCredit) consumes this.
export type IssueCashbackCreditJobData = {
    orderId: string;
    user: string; // 0x-prefixed
    amount: string; // USDC 6-decimals as a uint256 string
};

// SettleClaim job payload — the insurance settlement keeper (see
// queue/workers/settleClaimJob.ts) settles one approved claim per job once its
// payout delay has elapsed. These jobs run on the DAILY KEEPER queue so the
// shared Keeper wallet keeps a single consumer; the name distinguishes them from
// that queue's own 'DailyKeeper' / 'DailyKeeperStartup' jobs.
export const SETTLE_CLAIM_JOB_NAME = 'SettleClaim';

export type SettleClaimJobData = {
    claimId: string; // uint256 claimId as a decimal string
};

// Empty payload jobs if needed
export type EmptyJobData = Record<string, never>;

export type ContractJobData =
    | ToggleOfflineJobData
    | OrderJobData
    | IssueCashbackCreditJobData
    | EmptyJobData;
