import { CommonConfig } from '../helpers/config';
import { logger } from '../helpers/logger';
import { getBaseHttpProvider } from '../helpers/provider';
import { DIAMOND_ABI } from '../helpers/abi';
import { Interface } from 'ethers';
import { Contract } from 'ethers';

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

        const logs = await provider.getLogs({
            address: config.diamondAddress,
            fromBlock,
            toBlock,
            topics: [topic],
        });

        if (!logs.length) {
            logger.debug(
                `getPendingOrdersFromLogs: no OrderPlaced logs in range [${fromBlock}, ${toBlock}]`,
            );
            return [];
        }

        logger.debug(
            `getPendingOrdersFromLogs: found ${logs.length} OrderPlaced logs in range [${fromBlock}, ${toBlock}]`,
        );

        const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, provider);
        const idsFromLogs: string[] = [];

        for (const log of logs) {
            try {
                const parsed = iface.parseLog(log);
                const orderId = parsed?.args?.orderId?.toString?.();

                if (!orderId) {
                    logger.warn(
                        `getPendingOrdersFromLogs: missing orderId in parsed log block=${log?.blockNumber}`,
                    );
                    continue;
                }

                const order = await diamond.getOrdersById(orderId);
                const status = Number(order.status);

                if (status >= STATUS_DONE_THRESHOLD) continue;

                logger.debug(
                    `getPendingOrdersFromLogs: active orderId=${orderId} (status=${status})`,
                );
                idsFromLogs.push(orderId);
            } catch (err: any) {
                logger.warn(
                    `getPendingOrdersFromLogs: failed to parse/load OrderPlaced log block=${log?.blockNumber}: ${String(
                        err?.message ?? err,
                    )}`,
                );
            }
        }

        return idsFromLogs;
    } catch (err: any) {
        logger.error(
            `getPendingOrdersFromLogs: failed for range [${fromBlock}, ${toBlock}]: ${String(
                err?.message ?? err,
            )}`,
        );
        return [];
    }
}

