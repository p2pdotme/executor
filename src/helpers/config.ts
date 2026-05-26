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
    // B2B cashback programme — credits a bps cut of every completed non-B2B
    // BUY back to the user via integrator.issueCredit(). The programme is
    // OFF when integrator address is empty or bps is 0; the OrderCompleted
    // listener silently skips in that case so the executor stays useful
    // for deploys that don't want the programme enabled.
    cashbackIntegratorAddress: string;
    cashbackBps: number;
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
    // Both optional. When either is unset/zero the cashback listener
    // short-circuits — keeps the executor usable for deploys that
    // don't have the programme enabled. When set, both must be valid.
    const cashbackIntegratorAddress = (process.env.CASHBACK_INTEGRATOR_ADDRESS ?? '').trim();
    const cashbackBpsRaw = (process.env.CASHBACK_BPS ?? '0').trim();
    const cashbackBps = Number(cashbackBpsRaw);
    if (Number.isNaN(cashbackBps) || cashbackBps < 0 || cashbackBps > 10_000) {
        throw new Error('CASHBACK_BPS must be an integer in [0, 10000]');
    }
    if (cashbackIntegratorAddress && !/^0x[0-9a-fA-F]{40}$/.test(cashbackIntegratorAddress)) {
        throw new Error('CASHBACK_INTEGRATOR_ADDRESS must be a 0x-prefixed 20-byte address');
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
        cashbackIntegratorAddress,
        cashbackBps,
    };
}

// Old loader names kept so existing imports compile without changes
export const loadCommonConfig = loadExecutorConfig;
export const loadToggleConfig = loadExecutorConfig;
export const loadAssignConfig = loadExecutorConfig;
export const loadToggleScheduleConfig = loadExecutorConfig;
export const loadOrderSweeperConfig = loadExecutorConfig;
