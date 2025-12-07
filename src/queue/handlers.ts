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

// WRITE: toggleMerchantsOffline(bytes32 currency, address[] merchants)
const toggleMerchantsOffline: ContractJobHandler = async (raw, ctx) => {
    const data = raw as ToggleOfflineJobData;

    if (!data.currency || !Array.isArray(data.merchants)) {
        logger.warn('toggleMerchantsOffline: invalid payload');
        return true;
    }

    const { currency, merchants, orderId } = data;

    // threshold from chain, default to 12 if anything weird
    let assignedOrdersThreshold = 12n;
    try {
        const rawThreshold = await ctx.diamond.getAssignedOrdersThreshold();
        if (rawThreshold !== undefined && rawThreshold !== null) {
            assignedOrdersThreshold = BigInt(rawThreshold);
        }
    } catch (err: any) {
        logger.warn(
            `toggleMerchantsOffline: getAssignedOrdersThreshold failed, defaulting to 12: ${String(
                err?.message ?? err,
            )}`,
        );
    }

    const inactiveMerchants: string[] = [];

    for (const merchant of merchants) {
        try {
            const rawStreak = await ctx.diamond.getPendingAssignStreak(merchant);
            const pendingAssignStreak = BigInt(rawStreak);

            if (pendingAssignStreak >= assignedOrdersThreshold) {
                logger.warn(
                    `⏩ toggleMerchantsOffline: merchant= ${merchant} reached threshold= ${assignedOrdersThreshold} (streak= ${pendingAssignStreak})`,
                );
                inactiveMerchants.push(merchant);
            }
        } catch (err: any) {
            logger.warn(
                `toggleMerchantsOffline: getPendingAssignStreak failed for merchant= ${merchant}: ${String(
                    err?.message ?? err,
                )}`,
            );
        }
    }

    if (!inactiveMerchants.length) {
        logger.debug(
            `toggleMerchantsOffline: no merchants to toggle for orderId= ${orderId}; skipping tx`,
        );
        return true;
    }

    // safeSend handles balance, gas, alerts, wait, etc.
    return safeSend(
        ctx.diamond,
        'toggleMerchantsOffline',
        [currency, inactiveMerchants],
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
            `❗ Order not PLACED. Skipping reassignment for orderId= ${orderId} (current status= ${order.status})`,
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
