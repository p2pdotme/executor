import { Contract, Interface } from 'ethers';
import { ContractCallerConfig } from '../helpers/config';
import { logger } from '../helpers/logger';
import { trackOrderIds } from './orderTracker';
import { getBaseHttpProvider } from '../helpers/provider';
import { DIAMOND_ABI } from '../helpers/abi';

const STATUS_DONE_THRESHOLD = 3; // >= 3 -> completed / cancelled
const LOG_LOOKBACK_BLOCKS = 1000;

export async function seedPendingOrdersToOrderSweeper(
    config: ContractCallerConfig,
) {
    try {
        const provider = getBaseHttpProvider(config);
        const latestBlock = await provider.getBlockNumber();
        const fromBlock = Math.max(0, latestBlock - LOG_LOOKBACK_BLOCKS);
        logger.info(`order-sweeper seed: looking back ${LOG_LOOKBACK_BLOCKS} blocks from block=${fromBlock} to block=${latestBlock}`);

        const iface = new Interface(DIAMOND_ABI);
        const event = iface.getEvent('OrderPlaced');
        const topic = event?.topicHash;

        if (!topic) {
            logger.error('order-sweeper seed: missing topic for OrderPlaced');
            return;
        }

        const logs = await provider.getLogs({
            address: config.diamondAddress,
            fromBlock,
            toBlock: latestBlock,
            topics: [topic],
        });

        if (!logs.length) {
            logger.info(
                `order-sweeper seed: no OrderPlaced logs in last ${LOG_LOOKBACK_BLOCKS} blocks`,
            );
            return;
        }

        logger.info(
            `order-sweeper seed: found ${logs.length} OrderPlaced logs in last ${LOG_LOOKBACK_BLOCKS} blocks`,
        );

        const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, provider);

        const idsFromLogs: string[] = [];

        for (const log of logs) {
            try {
                const parsed = iface.parseLog(log);
                const orderId = parsed?.args?.orderId?.toString?.();

                if (!orderId) {
                    logger.warn(
                        `order-sweeper seed: missing orderId in parsed log block=${log?.blockNumber}`,
                    );
                    continue;
                }

                const order = await diamond.getOrdersById(orderId);
                const status = Number(order.status);

                if (status >= STATUS_DONE_THRESHOLD) {
                    logger.debug(
                        `order-sweeper seed: skipping orderId=${orderId} from logs; status=${status} (completed/cancelled)`,
                    );
                    continue;
                }

                logger.debug(
                    `order-sweeper seed: will track active orderId=${orderId} from logs (status=${status})`,
                );
                idsFromLogs.push(orderId);
            } catch (err: any) {
                logger.warn(
                    `order-sweeper seed: failed to parse / load OrderPlaced log block=${log?.blockNumber}: ${String(
                        err?.message ?? err,
                    )}`,
                );
            }
        }

        const uniqueIds = Array.from(new Set(idsFromLogs));

        if (uniqueIds.length) {
            await trackOrderIds(uniqueIds);
            logger.info(
                `order-sweeper seed: tracked ${uniqueIds.length} active orders from last ${LOG_LOOKBACK_BLOCKS} blocks`,
            );
        } else {
            logger.info(
                'order-sweeper seed: no active orders found from OrderPlaced logs',
            );
        }
    } catch (err: any) {
        logger.error(
            `order-sweeper seed: log-based seeding failed: ${String(
                err?.message ?? err,
            )}`,
        );
    }
}
