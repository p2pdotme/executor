export type CommonConfig = {
    alchemyApiKey: string;
    diamondAddress: string;

    onFailBotToken: string;
    onFailChanneld: string;
    onFailTopicId: string;

    minBaseBalanceEth: number;
};

export type ToggleConfig = CommonConfig & {
    toggleExecutor: string;
};

export type AssignConfig = CommonConfig & {
    assignExecutor: string;
    assignDelayInSeconds: number;
};

export type ToggleScheduleConfig = CommonConfig & {
    toggleScheduleExecutor: string;
};

export type OrderSweeperConfig = CommonConfig & {
    orderSweeperExecutor: string;
};

export type ContractCallerConfig = ToggleConfig | AssignConfig | ToggleScheduleConfig | OrderSweeperConfig;

function requireEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Missing env: ${name}`);
    return v;
}

export function loadCommonConfig(): CommonConfig {
    const alchemyApiKey = requireEnv('ALCHEMY_API_KEY');
    const diamondAddress = requireEnv('DIAMOND_ADDRESS');
    const onFailBotToken = requireEnv('TELEGRAM_ONFAIL_BOT_TOKEN');
    const onFailChanneld = requireEnv('TELEGRAM_ONFAIL_CHANNEL_ID');
    const onFailTopicId = requireEnv('TELEGRAM_ONFAIL_TOPIC_ID');

    const minBaseBalanceEth = Number(process.env.MIN_BASE_BALANCE_ETH ?? '0.005');
    if (Number.isNaN(minBaseBalanceEth) || minBaseBalanceEth <= 0) {
        throw new Error('MIN_BASE_BALANCE_ETH must be a positive number');
    }

    return {
        alchemyApiKey,
        diamondAddress,
        onFailBotToken,
        onFailChanneld,
        onFailTopicId,
        minBaseBalanceEth,
    };
}

export function loadToggleConfig(): ToggleConfig {
    const commonConfig = loadCommonConfig();
    const toggleExecutor = requireEnv('TOGGLE_EXECUTOR');
    return {
        ...commonConfig,
        toggleExecutor,
    };
}

export function loadAssignConfig(): AssignConfig {
    const commonConfig = loadCommonConfig();
    const assignExecutor = requireEnv('ASSIGN_EXECUTOR');
    const assignDelayInSeconds = Number(requireEnv('ASSIGN_DELAY_IN_SECONDS'));
    if (Number.isNaN(assignDelayInSeconds) || assignDelayInSeconds <= 0) {
        throw new Error('ASSIGN_DELAY_IN_SECONDS must be a positive number');
    }
    return {
        ...commonConfig,
        assignExecutor,
        assignDelayInSeconds,
    };
}

export function loadToggleScheduleConfig(): ToggleScheduleConfig {
    const commonConfig = loadCommonConfig();
    const toggleScheduleExecutor = requireEnv('TOGGLE_SCHEDULE_EXECUTOR');
    return {
        ...commonConfig,
        toggleScheduleExecutor,
    };
}

export function loadOrderSweeperConfig(): OrderSweeperConfig {
    const commonConfig = loadCommonConfig();
    const orderSweeperExecutor = requireEnv('ORDER_SWEEPER_EXECUTOR');
    return {
        ...commonConfig,
        orderSweeperExecutor,
    };
}
