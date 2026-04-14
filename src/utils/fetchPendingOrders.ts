import { CommonConfig } from '../helpers/config';
import { logger } from '../helpers/logger';
import { getBaseHttpProvider, withTimeout } from '../helpers/provider';
import { DIAMOND_ABI } from '../helpers/abi';
import { Interface } from 'ethers';
import { getMulticall3 } from '../helpers/multicall';

const STATUS_DONE_THRESHOLD = 3; // >= 3 -> completed / cancelled

// returns active (status < STATUS_DONE_THRESHOLD) orderIds from logs
export async function getPendingOrdersFromLogs(
    config: CommonConfig,
    fromBlock: number,
    toBlock: number,
): Promise<string[]> {
    try {
        const provider = getBaseHttpProvider(config);
        const iface = new Interface(DIAMOND_ABI);
        const event = iface.getEvent('OrderPlaced');
        const topic = event?.topicHash;

        if (!topic) {
            logger.error('getPendingOrdersFromLogs: missing topic for OrderPlaced');
            return [];
        }

        logger.info(
            `getPendingOrdersFromLogs: scanning OrderPlaced logs from block=${fromBlock} to block=${toBlock}`,
        );

        const logs = await withTimeout(
            provider.getLogs({
                address: config.diamondAddress,
                fromBlock,
                toBlock,
                topics: [topic],
            }),
            30_000,
        );

        if (!logs.length) {
            logger.debug(
                `getPendingOrdersFromLogs: no OrderPlaced logs in range [${fromBlock}, ${toBlock}]`,
            );
            return [];
        }

        logger.debug(
            `getPendingOrdersFromLogs: found ${logs.length} OrderPlaced logs in range [${fromBlock}, ${toBlock}]`,
        );

        // Parse all order IDs from logs first
        const orderIds: string[] = [];
        for (const log of logs) {
            try {
                const parsed = iface.parseLog(log);
                const orderId = parsed?.args?.orderId?.toString?.();
                if (orderId) {
                    orderIds.push(orderId);
                } else {
                    logger.warn(
                        `getPendingOrdersFromLogs: missing orderId in parsed log block=${log?.blockNumber}`,
                    );
                }
            } catch (err: any) {
                logger.warn(
                    `getPendingOrdersFromLogs: failed to parse log block=${log?.blockNumber}: ${String(err?.message ?? err)}`,
                );
            }
        }

        if (!orderIds.length) return [];

        // Batch all getOrdersById calls into a single Multicall3 eth_call (N → 1 RPC call)
        const multicall3 = getMulticall3(provider);
        const calls = orderIds.map(id => ({
            target: config.diamondAddress,
            allowFailure: true,
            callData: iface.encodeFunctionData('getOrdersById', [BigInt(id)]),
        }));

        let results: any[];
        try {
            results = await withTimeout(multicall3.aggregate3.staticCall(calls), 30_000);
        } catch (err: any) {
            logger.error(`getPendingOrdersFromLogs: Multicall3 batch failed: ${err.message}`);
            return [];
        }

        const activeIds: string[] = [];
        for (let i = 0; i < orderIds.length; i++) {
            const id = orderIds[i];
            const result = results[i];

            if (!result.success) {
                logger.warn(`getPendingOrdersFromLogs: getOrdersById multicall failed for orderId=${id}`);
                continue;
            }

            try {
                const [order] = iface.decodeFunctionResult('getOrdersById', result.returnData);
                const status = Number(order.status);
                if (status < STATUS_DONE_THRESHOLD) {
                    logger.debug(`getPendingOrdersFromLogs: active orderId=${id} (status=${status})`);
                    activeIds.push(id);
                }
            } catch (err: any) {
                logger.warn(`getPendingOrdersFromLogs: decode failed for orderId=${id}: ${err.message}`);
            }
        }

        return activeIds;
    } catch (err: any) {
        logger.error(
            `getPendingOrdersFromLogs: failed for range [${fromBlock}, ${toBlock}]: ${String(
                err?.message ?? err,
            )}`,
        );
        return [];
    }
}
