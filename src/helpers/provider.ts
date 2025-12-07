import { JsonRpcProvider, WebSocketProvider, Wallet } from 'ethers';
import { ContractCallerConfig } from './config';
import { logger } from './logger';

const httpCache: Record<string, JsonRpcProvider> = {};

export function getHttpProvider(rpcHttp: string): JsonRpcProvider {
    if (!rpcHttp) throw new Error('missing rpcHttp');
    if (httpCache[rpcHttp]) return httpCache[rpcHttp];
    const provider = new JsonRpcProvider(rpcHttp);
    httpCache[rpcHttp] = provider;
    return provider;
}

export function getWsProvider(rpcWs: string): WebSocketProvider {
    if (!rpcWs) throw new Error('missing rpcWs');
    const provider = new WebSocketProvider(rpcWs);

    provider.on('error', (err: any) => {
        logger.error(`❌ ws provider error: ${String(err?.message ?? err)}`);
    });

    return provider;
}

export function getBaseHttpProvider(config: ContractCallerConfig): JsonRpcProvider {
    const url = `https://base-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`;
    return getHttpProvider(url);
}

export function getBaseWsProvider(config: ContractCallerConfig): WebSocketProvider {
    const url = `wss://base-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`;
    return getWsProvider(url);
}

// dedicated signer for ToggleMerchantsOffline
export function getToggleSigner(config: ContractCallerConfig): Wallet {
    const provider = getBaseHttpProvider(config);
    return new Wallet(config.toggleExecutor, provider);
}

// dedicated signer for AssignMerchants
export function getAssignSigner(config: ContractCallerConfig): Wallet {
    const provider = getBaseHttpProvider(config);
    return new Wallet(config.assignExecutor, provider);
}

// dedicated signer for ToggleMerchantsOffline (scheduled)
export function getToggleScheduleSigner(config: ContractCallerConfig): Wallet {
    const provider = getBaseHttpProvider(config);
    return new Wallet(config.toggleScheduleExecutor, provider);
}

export function getOrderSweeperSigner(config: ContractCallerConfig): Wallet {
    const provider = getBaseHttpProvider(config);
    return new Wallet(config.orderSweeperExecutor, provider);
}

export function getOrderScannerSigner(config: ContractCallerConfig): Wallet {
    const provider = getBaseHttpProvider(config);
    return new Wallet(config.orderScannerExecutor, provider);
}
