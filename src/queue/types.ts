// All job names the executor will handle
export type ContractJobName =
    | 'ToggleMerchantsOffline'
    | 'AssignMerchants'
    | 'GetOrdersById';

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

// ToggleSchedule job payload
export type ToggleScheduleJobData = {
    currency: string;
};

// Empty payload jobs if needed
export type EmptyJobData = Record<string, never>;

export type ContractJobData =
    | ToggleOfflineJobData
    | OrderJobData
    | ToggleScheduleJobData
    | EmptyJobData;
