import { Contract } from 'ethers';
import { ContractCallerConfig } from '../helpers/config';
import { logger } from '../helpers/logger';
import {
    ContractJobName,
    ContractJobData,
    OrderJobData,
    ToggleOfflineJobData,
} from './types';
import { safeSend } from '../helpers/safeSend';

export type HandlerContext = {
    config: ContractCallerConfig;
    diamond: Contract;
};

export type ContractJobHandler =
    (data: ContractJobData, ctx: HandlerContext) => Promise<boolean>;

const STATUS_PLACED = 0n;

// WRITE: removeNonEligibleMerchants(bytes32 currency, address[] prevs, address[] targets)
const toggleMerchantsOffline: ContractJobHandler = async (raw, ctx) => {
    const LIMIT = 10;
    const data = raw as ToggleOfflineJobData;

    const { currency, orderId } = data;

    const [prevsResult, targetsResult] =
        await ctx.diamond.getNonEligibleMerchants(currency, LIMIT);

    const prevs = [...prevsResult];
    const targets = [...targetsResult];

    if (!targets || targets.length === 0) {
        logger.debug(
            `toggleWorker: no non-eligible merchants found currency=${currency}`,
        );
        return true;
    }

    return safeSend(
        ctx.diamond,
        'removeNonEligibleMerchants',
        [currency, prevs, targets],
        ctx.config,
        { orderId },
    );
};

// WRITE: assignMerchants(orderId) but only if order still PLACED
const assignMerchants: ContractJobHandler = async (raw, ctx) => {
    const data = raw as OrderJobData;
    const orderId = data.orderId;

    const order = await ctx.diamond.getOrdersById(orderId);
    if (!order) return true;

    if (Number(order.status) !== Number(STATUS_PLACED)) {
        logger.debug(
            `❗ Skipping reassignment for orderId= ${orderId} (current status= ${order.status})`,
        );
        return true;
    }

    return safeSend(
        ctx.diamond,
        'assignMerchants',
        [orderId],
        ctx.config,
        { orderId },
    );
};


// GetOrdersById (debug)
const getOrdersById: ContractJobHandler = async (raw, ctx) => {
    const data = raw as OrderJobData;
    const res = await ctx.diamond.getOrdersById(data.orderId);
    logger.info(`getOrdersById result: ${JSON.stringify(res)}`);
    return true;
};

export const handlers: Record<ContractJobName, ContractJobHandler> = {
    ToggleMerchantsOffline: toggleMerchantsOffline,
    AssignMerchants: assignMerchants,
    GetOrdersById: getOrdersById,
};
