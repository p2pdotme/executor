import { Contract } from 'ethers';
import { ContractCallerConfig } from '../helpers/config';
import { getBaseWsProvider, getBaseHttpProvider } from '../helpers/provider';
import { DIAMOND_ABI } from '../helpers/abi';
import { logger } from '../helpers/logger';
import { addToggleJob, addAssignJob } from '../queue';
import { currencyMap, getMerchantAddressesFromTx, resolveOrderFromEventOrChain } from './utils';
import { trackOrderId } from '../utils/orderTracker';

const ORDER_PLACED_EVENT = 'OrderPlaced';

export async function attachOrderPlacedListener(config: ContractCallerConfig) {
    const ASSIGN_DELAY_MS = config.assignDelayInSeconds * 1000 + 1_000; // 1s buffer
    const wsProvider = getBaseWsProvider(config);
    const httpProvider = getBaseHttpProvider(config);

    const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, wsProvider);

    diamond.on(ORDER_PLACED_EVENT, async (...args: any[]) => {
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
                `OrderPlaced: orderId= ${orderIdStr} currency= ${currencyName} txHash= ${txHash}`,
            );

            // fetch merchants from tx logs using DIAMOND_ABI
            const merchants = await getMerchantAddressesFromTx(
                httpProvider,
                txHash,
                config.diamondAddress,
            );

            if (merchants.length) {
                logger.info(
                    `OrderPlaced: found ${merchants.length} merchants for orderId= ${orderIdStr}`,
                );

                // immediate: toggleMerchantsOffline(currency, merchants)
                await addToggleJob(
                    config,
                    'ToggleMerchantsOffline',
                    { orderId: orderIdStr, currency: currencyStr, merchants, txHash },
                    { jobId: `toggle-${orderIdStr}`, delayMs: 0 },
                );

                logger.info(
                    `OrderPlaced: enqueued ToggleMerchantsOffline for orderId= ${orderIdStr}`,
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
                `OrderPlaced: delayed AssignMerchants scheduled orderId= ${orderIdStr} delay= ${ASSIGN_DELAY_MS}ms`,
            );
        } catch (err: any) {
            logger.error(
                { error: String(err?.message ?? err) },
                'OrderPlaced listener error',
            );
        }
    });

    logger.info(`OrderPlaced listener attached for diamond: ${config.diamondAddress}`);
}
