import { Contract } from 'ethers';
import { ContractCallerConfig } from '../helpers/config';
import { getBaseWsProvider, getBaseHttpProvider } from '../helpers/provider';
import { DIAMOND_ABI } from '../helpers/abi';
import { logger } from '../helpers/logger';
import { addToggleJob, addAssignJob } from '../queue';
import { currencyMap, getMerchantAddressesFromTx, resolveOrderFromEventOrChain } from './utils';
import { trackOrderId } from '../utils/orderTracker';
import { sendTelegramMessage } from '../helpers/alerts';

const ORDER_PLACED_EVENT = 'OrderPlaced';

export async function attachOrderPlacedListener(config: ContractCallerConfig) {
    const ASSIGN_DELAY_MS = config.assignDelayInSeconds * 1000 + 1_000; // 1s buffer
    const httpProvider = getBaseHttpProvider(config);

    const setup = () => {
        const wsProvider = getBaseWsProvider(config);
        const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, wsProvider);

        const handler = async (...args: any[]) => {
            const payload = args[args.length - 1];

            try {
                if (!payload || typeof payload !== 'object') return;

                const txHash = payload.log?.transactionHash;
                if (!txHash) return;

                const order = await resolveOrderFromEventOrChain(payload, diamond);
                if (!order) return;

                const orderIdStr = String(order.id);
                await trackOrderId(orderIdStr);
                logger.debug(`OrderPlaced: tracking orderId=${orderIdStr} for autocancel`);

                const currencyStr = String(order.currency);
                const currencyName = currencyMap[currencyStr] ?? currencyStr;

                logger.info(
                    `OrderPlaced: orderId=${orderIdStr} currency=${currencyName} txHash=${txHash}`,
                );

                // fetch merchants from tx logs using DIAMOND_ABI
                const merchants = await getMerchantAddressesFromTx(
                    httpProvider,
                    txHash,
                    config.diamondAddress,
                );

                if (merchants.length) {
                    logger.info(
                        `OrderPlaced: found ${merchants.length} merchants for orderId=${orderIdStr}`,
                    );

                    // immediate: toggleMerchantsOffline(currency, merchants)
                    await addToggleJob(
                        config,
                        'ToggleMerchantsOffline',
                        {
                            orderId: orderIdStr,
                            currency: currencyStr,
                            merchants,
                            txHash,
                        },
                        { jobId: `toggle-${orderIdStr}`, delayMs: 0 },
                    );

                    logger.info(
                        `OrderPlaced: enqueued ToggleMerchantsOffline for orderId=${orderIdStr}`,
                    );
                }

                // delayed AssignMerchants (BullMQ delay, assign queue)
                await addAssignJob(
                    config,
                    'AssignMerchants',
                    { orderId: orderIdStr, txHash },
                    { jobId: `assign-${orderIdStr}`, delayMs: ASSIGN_DELAY_MS },
                );

                logger.info(
                    `OrderPlaced: delayed AssignMerchants scheduled orderId=${orderIdStr} delay=${ASSIGN_DELAY_MS}ms`,
                );
            } catch (err: any) {
                logger.error(
                    { error: String(err?.message ?? err) },
                    'OrderPlaced listener error',
                );
            }
        };

        diamond.on(ORDER_PLACED_EVENT, handler);

        logger.info(`OrderPlaced listener attached for diamond: ${config.diamondAddress}`);

        // notify on startup / reconnect
        void sendTelegramMessage(
            config.onFailBotToken,
            config.onFailChanneld,
            config.onFailTopicId,
            '✅ WS connected: OrderPlaced listener attached',
        ).catch(() => { });

        // low-level ws handle to detect close/error and reconnect
        const ws: any =
            (wsProvider as any)._websocket ??
            (wsProvider as any).websocket ??
            (wsProvider as any)._ws ??
            null;

        if (!ws) {
            logger.warn(
                '⚠️ OrderPlaced: ws handle not found; reconnect hooks not attached',
            );
            return;
        }

        ws.onclose = (evt: any) => {
            const msg = `⚠️ OrderPlaced WS closed code=${evt?.code} reason=${evt?.reason ?? ''}. Reconnecting in 5s...`;
            logger.error(msg);

            void sendTelegramMessage(
                config.onFailBotToken,
                config.onFailChanneld,
                config.onFailTopicId,
                msg,
            ).catch(() => { });

            diamond.removeAllListeners(ORDER_PLACED_EVENT);

            setTimeout(() => {
                logger.info('OrderPlaced: reconnecting WS listener after close');
                setup();
            }, 5_000);
        };

        ws.onerror = (err: any) => {
            const msg = `⚠️ OrderPlaced WS error: ${String(
                err?.message ?? err,
            )}. Reconnecting in 5s...`;
            logger.error(msg);

            void sendTelegramMessage(
                config.onFailBotToken,
                config.onFailChanneld,
                config.onFailTopicId,
                msg,
            ).catch(() => { });

            diamond.removeAllListeners(ORDER_PLACED_EVENT);

            setTimeout(() => {
                logger.info('OrderPlaced: reconnecting WS listener after error');
                setup();
            }, 5_000);
        };
    };

    // initial attach
    setup();
}
