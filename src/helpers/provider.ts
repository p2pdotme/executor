import { JsonRpcProvider, WebSocketProvider, Wallet, NonceManager } from 'ethers';
import { ExecutorConfig } from './config';
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

export function getBaseHttpProvider(config: ExecutorConfig): JsonRpcProvider {
    const url = `https://base-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`;
    return getHttpProvider(url);
}

export function getBaseWsProvider(config: ExecutorConfig): WebSocketProvider {
    const url = `wss://base-mainnet.g.alchemy.com/v2/${config.alchemyApiKey}`;
    return getWsProvider(url);
}

/** Signer for the funding wallet — used only to auto-top-up subwallets, not for contract calls */
export function getFundingSigner(config: ExecutorConfig): NonceManager {
    const provider = getBaseHttpProvider(config);
    return new NonceManager(new Wallet(config.fundingExecutorKey, provider));
}

export async function withTimeout<T>(p: Promise<T>, ms = 100_000): Promise<T> {
    let timeoutId: NodeJS.Timeout;

    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
            reject(new Error('RPC timeout'));
        }, ms);
    });

    return await Promise.race([p, timeoutPromise])
        .finally(() => {
            if (timeoutId) clearTimeout(timeoutId);
        });
}
