export type ContractCallerConfig = {
    alchemyApiKey: string;
    diamondAddress: string;
    toggleExecutor: string;
    assignExecutor: string;
    toggleScheduleExecutor: string;
    orderSweeperExecutor: string;
    orderScannerExecutor: string;
    assignDelayInSeconds: number;

    onFailBotToken: string;
    onFailChanneld: string;
    onFailTopicId: string;

    minBaseBalanceEth: number;
    subgraphUrl?: string;
};

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

export function loadConfig(): ContractCallerConfig {
    const alchemyApiKey = requireEnv('ALCHEMY_API_KEY');
    const diamondAddress = requireEnv('DIAMOND_ADDRESS');
    const toggleExecutor = requireEnv('TOGGLE_EXECUTOR');
    const assignExecutor = requireEnv('ASSIGN_EXECUTOR');
    const toggleScheduleExecutor = requireEnv('TOGGLE_SCHEDULE_EXECUTOR');
    const orderSweeperExecutor = requireEnv('ORDER_SWEEPER_EXECUTOR');
    const orderScannerExecutor = requireEnv('ORDER_SCANNER_EXECUTOR');
    const onFailBotToken = requireEnv('TELEGRAM_ONFAIL_BOT_TOKEN');
    const onFailChanneld = requireEnv('TELEGRAM_ONFAIL_CHANNEL_ID');
    const onFailTopicId = requireEnv('TELEGRAM_ONFAIL_TOPIC_ID');

    const assignDelayInSeconds = Number(requireEnv('ASSIGN_DELAY_IN_SECONDS'));
    if (Number.isNaN(assignDelayInSeconds) || assignDelayInSeconds <= 0) {
        throw new Error('ASSIGN_DELAY_IN_SECONDS must be a positive number');
    }
    const minBaseBalanceEth = Number(process.env.MIN_BASE_BALANCE_ETH ?? '0.005');
    if (Number.isNaN(minBaseBalanceEth) || minBaseBalanceEth <= 0) {
        throw new Error('MIN_BASE_BALANCE_ETH must be a positive number');
    }

    const subgraphUrl = process.env.SUBGRAPH_URL;

    return {
        alchemyApiKey,
        diamondAddress,
        toggleExecutor,
        assignExecutor,
        toggleScheduleExecutor,
        orderSweeperExecutor,
        orderScannerExecutor,
        assignDelayInSeconds,
        onFailBotToken,
        onFailChanneld,
        onFailTopicId,
        minBaseBalanceEth,
        subgraphUrl,
    };
}
