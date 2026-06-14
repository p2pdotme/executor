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
    // Goldsky subgraph endpoint used by the daily keeper to enumerate
    // unstake-requested + inactive merchants. Defaults to the prod endpoint.
    subgraphUrl: string;
    // B2B cashback programme — credits a bps cut of every completed non-B2B
    // BUY or SELL back to the order's user (buyer for BUY, seller for SELL)
    // via integrator.issueCredit(). The programme is OFF when integrator
    // address is empty or bps is 0; the OrderCompleted listener silently
    // skips in that case so the executor stays useful for deploys that
    // don't want the programme enabled.
    cashbackIntegratorAddress: string;
    // Default cashback rate applied to every eligible order unless the
    // order's currency has a per-currency override below.
    cashbackBps: number;
    // Per-currency cashback overrides keyed by the order's currency code
    // (the decoded bytes32 symbol, e.g. "ARS"). A currency present here
    // uses its bps instead of the default cashbackBps. Resolved at order
    // completion time from the order's `currency` field.
    cashbackBpsByCurrency: Record<string, number>;
};

// Built-in per-currency cashback overrides. These ship as defaults so the
// business rule holds even if the operator forgets to set the env var; the
// CASHBACK_BPS_BY_CURRENCY env (parsed below) takes precedence per currency.
// ARS (Argentina) and MEX (Mexico) have tighter spreads where users were
// farming lotpot credits, so both credit 1% (100 bps) vs the default 2%.
const DEFAULT_CASHBACK_BPS_BY_CURRENCY: Record<string, number> = {
    ARS: 100,
    MEX: 100,
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

// Parse the per-currency cashback override env into a {CODE: bps} map and
// merge it over the built-in defaults (env wins per currency). Format is a
// comma-separated list of CODE:bps pairs, e.g. "ARS:100,VEN:50". Currency
// codes are upper-cased to match the decoded bytes32 symbol on the order.
function parseCashbackBpsByCurrency(raw: string): Record<string, number> {
    const map: Record<string, number> = { ...DEFAULT_CASHBACK_BPS_BY_CURRENCY };
    const trimmed = raw.trim();
    if (!trimmed) return map;

    for (const part of trimmed.split(',')) {
        const entry = part.trim();
        if (!entry) continue;
        const [codeRaw, bpsRaw] = entry.split(':');
        const code = (codeRaw ?? '').trim().toUpperCase();
        const bps = Number((bpsRaw ?? '').trim());
        if (!code) {
            throw new Error(
                `CASHBACK_BPS_BY_CURRENCY: missing currency code in entry "${entry}"`,
            );
        }
        if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) {
            throw new Error(
                `CASHBACK_BPS_BY_CURRENCY: bps for ${code} must be an integer in [0, 10000], got "${bpsRaw}"`,
            );
        }
        map[code] = bps;
    }
    return map;
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
    const cashbackBpsByCurrency = parseCashbackBpsByCurrency(
        process.env.CASHBACK_BPS_BY_CURRENCY ?? '',
    );
    const subgraphUrl = (process.env.SUBGRAPH_URL ?? '').trim();
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
        subgraphUrl,
        cashbackIntegratorAddress,
        cashbackBps,
        cashbackBpsByCurrency,
    };
}

// Old loader names kept so existing imports compile without changes
export const loadCommonConfig = loadExecutorConfig;
export const loadToggleConfig = loadExecutorConfig;
export const loadAssignConfig = loadExecutorConfig;
export const loadToggleScheduleConfig = loadExecutorConfig;
export const loadOrderSweeperConfig = loadExecutorConfig;
