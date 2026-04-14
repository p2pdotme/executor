export type ExecutorConfig = {
    alchemyApiKey: string;
    diamondAddress: string;
    // Three dedicated Discord channel webhooks — mirrors the old Telegram topic split
    discordOnSuccessWebhookUrl: string;
    discordOnFailWebhookUrl: string;
    discordBalanceWebhookUrl: string;
    fundingExecutorKey: string;
    minBaseBalanceEth: number;
    dryRun: boolean;
    assignDelayInSeconds: number;
};

// Backward-compat aliases — all workers/helpers use ExecutorConfig under the hood
export type CommonConfig = ExecutorConfig;
export type ContractCallerConfig = ExecutorConfig;
export type ToggleConfig = ExecutorConfig;
export type AssignConfig = ExecutorConfig;
export type ToggleScheduleConfig = ExecutorConfig;
export type OrderSweeperConfig = ExecutorConfig;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

export function loadExecutorConfig(): ExecutorConfig {
    const alchemyApiKey = requireEnv('ALCHEMY_API_KEY');
    const diamondAddress = requireEnv('DIAMOND_ADDRESS');
    const discordOnSuccessWebhookUrl = requireEnv('DISCORD_ONSUCCESS_WEBHOOK_URL');
    const discordOnFailWebhookUrl = requireEnv('DISCORD_ONFAIL_WEBHOOK_URL');
    const discordBalanceWebhookUrl = requireEnv('DISCORD_BALANCE_WEBHOOK_URL');
    const fundingExecutorKey = requireEnv('FUNDING_EXECUTOR');
    const dryRun = process.env.DRY_RUN === 'true';
    const minBaseBalanceEth = Number(process.env.MIN_BASE_BALANCE_ETH ?? '0.005');
    if (Number.isNaN(minBaseBalanceEth) || minBaseBalanceEth <= 0) {
        throw new Error('MIN_BASE_BALANCE_ETH must be a positive number');
    }
    const assignDelayInSeconds = Number(requireEnv('ASSIGN_DELAY_IN_SECONDS'));
    if (Number.isNaN(assignDelayInSeconds) || assignDelayInSeconds <= 0) {
        throw new Error('ASSIGN_DELAY_IN_SECONDS must be a positive number');
    }
    return {
        alchemyApiKey,
        diamondAddress,
        discordOnSuccessWebhookUrl,
        discordOnFailWebhookUrl,
        discordBalanceWebhookUrl,
        fundingExecutorKey,
        minBaseBalanceEth,
        dryRun,
        assignDelayInSeconds,
    };
}

// Old loader names kept so existing imports compile without changes
export const loadCommonConfig = loadExecutorConfig;
export const loadToggleConfig = loadExecutorConfig;
export const loadAssignConfig = loadExecutorConfig;
export const loadToggleScheduleConfig = loadExecutorConfig;
export const loadOrderSweeperConfig = loadExecutorConfig;
