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

// SendPrizerailEntry job payload — the Prizerail draw programme (see
// queue/workers/prizerailEntryWorker.ts). One job per eligible order; the
// worker derives the pseudonymous entrant id from `user` and posts an
// increment-mode event keyed by orderId. Runs on its own queue.
export const PRIZERAIL_ENTRY_JOB_NAME = 'SendPrizerailEntry';

export type PrizerailEntryJobData = {
    orderId: string;
    user: string; // 0x-prefixed wallet; never sent to Prizerail as-is
    entries: number; // integer >= 1
    // For the Discord alert only. Optional: jobs queued before these existed have neither.
    amountUsdc?: string; // order amount, 6-decimal USDC units
    currency?: string; // on-chain currency code
};

// PrizerailPayout job payload — one winner row to pay from the prize
// wallet (see queue/workers/prizerailPayoutWorker.ts). Keyed by the
// ledger's primary key; the worker claims the row before sending.
export const PRIZERAIL_PAYOUT_JOB_NAME = 'PrizerailPayout';

export type PrizerailPayoutJobData = {
    campaign: string;
    drawingId: string;
    position: number;
};

// SettleClaim job payload — the insurance settlement keeper (see
// queue/workers/settleClaimJob.ts) settles one approved claim per job once its
// 48h contest window has elapsed. These jobs run on the DAILY KEEPER queue so the
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
