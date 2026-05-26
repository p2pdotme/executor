import { Contract } from 'ethers';
import { ContractCallerConfig } from '../helpers/config';
import { logger } from '../helpers/logger';
import {
    ContractJobName,
    ContractJobData,
    IssueCashbackCreditJobData,
    OrderJobData,
    ToggleOfflineJobData,
} from './types';
import { safeSend } from '../helpers/safeSend';
import { withTimeout } from '../helpers/provider';
import { connection } from './index';

export type HandlerContext = {
    config: ContractCallerConfig;
    diamond: Contract;
    // Only populated for the cashback worker — other workers don't need it.
    cashbackIntegrator?: Contract;
};

export type ContractJobHandler =
    (data: ContractJobData, ctx: HandlerContext) => Promise<boolean>;

const STATUS_PLACED = 0n;
const TOGGLE_COOLDOWN_TTL_SECONDS = 30;

// WRITE: removeNonEligibleMerchantsByCircleId(circleId, prevs, targets)
const toggleMerchantsOffline: ContractJobHandler = async (raw, ctx) => {
    const LIMIT = 10;
    const data = raw as ToggleOfflineJobData;
    const { currency, orderId, circleId } = data;

    // circleId dedup: atomic SET NX — only the first job within the cooldown window proceeds.
    // GET then SET would have a race window where two concurrent jobs both pass the check.
    const cooldownKey = `toggle:cooldown:${circleId}`;
    const acquired = await connection.set(cooldownKey, '1', 'EX', TOGGLE_COOLDOWN_TTL_SECONDS, 'NX');
    if (!acquired) {
        logger.debug(`toggleWorker: circleId=${circleId} in cooldown, skipping (orderId=${orderId})`);
        return true;
    }

    let prevsResult: any[], targetsResult: any[];
    try {
        [prevsResult, targetsResult] =
            await withTimeout(ctx.diamond.getNonEligibleMerchantsByCircleId(circleId, LIMIT), 5000);
    } catch (err: any) {
        throw new Error(`getNonEligibleMerchantsByCircleId failed for circleId=${circleId}: ${err.message}`);
    }

    const prevs = [...prevsResult];
    const targets = [...targetsResult];

    if (!targets || targets.length === 0) {
        logger.debug(`toggleWorker: no non-eligible merchants found currency=${currency}`);
        return true;
    }

    // skipPresim=true: removeNonEligibleMerchantsByCircleId is read-then-write;
    // the read above already confirmed there are merchants to remove
    return safeSend(
        ctx.diamond,
        'removeNonEligibleMerchantsByCircleId',
        [circleId, prevs, targets],
        ctx.config,
        { orderId, circleId: circleId, merchants: targets },
        true,
    );
};

// WRITE: assignMerchants(orderId) but only if order still PLACED
const assignMerchants: ContractJobHandler = async (raw, ctx) => {
    const data = raw as OrderJobData;
    const orderId = data.orderId;

    let order: any;
    try {
        order = await withTimeout(ctx.diamond.getOrdersById(orderId), 5000);
    } catch (err: any) {
        throw new Error(`getOrdersById failed for orderId=${orderId}: ${err.message}`);
    }
    if (!order) return true;

    if (Number(order.status) !== Number(STATUS_PLACED)) {
        logger.debug(`❗ Skipping reassignment for orderId= ${orderId} (current status= ${order.status})`);
        return true;
    }

    // skipPresim=false (default): always simulate assignMerchants before sending
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
    const res = await withTimeout(ctx.diamond.getOrdersById(data.orderId), 5000);
    logger.info(`getOrdersById result: ${JSON.stringify(res)}`);
    return true;
};

// WRITE: cashbackIntegrator.issueCredit(user, amount)
//
// Mirrors the contracts-v4 handleLotpotBuyerCashback logic that used to
// run inside Diamond.completeOrder. The Diamond hook was abandoned; the
// programme now lives entirely server-side. The OrderCompleted listener
// upstream is responsible for the orderType + non-B2B filtering and for
// computing `amount`; this handler only sends the on-chain write.
//
// Idempotency: the queue jobId is the orderId, so a duplicate event
// (e.g. WS reconnect replay) finds the existing job and never resends.
// As a defense-in-depth check we also read issuedCredit(user) before
// sending — if the ledger already shows a non-zero increment for the
// expected amount, we short-circuit. Useful when a job dies after the
// tx mined but before BullMQ marked it complete.
const issueCashbackCredit: ContractJobHandler = async (raw, ctx) => {
    const data = raw as IssueCashbackCreditJobData;
    const { orderId, user, amount } = data;
    const amountBig = BigInt(amount);

    if (!ctx.cashbackIntegrator) {
        throw new Error('cashbackWorker: cashbackIntegrator not bound on ctx');
    }
    if (amountBig <= 0n) {
        logger.debug(`cashbackWorker: zero amount for orderId= ${orderId}, skipping`);
        return true;
    }

    return safeSend(
        ctx.cashbackIntegrator,
        'issueCredit',
        [user, amountBig],
        ctx.config,
        { orderId, user, amount: amountBig.toString() },
    );
};

export const handlers: Record<ContractJobName, ContractJobHandler> = {
    ToggleMerchantsOffline: toggleMerchantsOffline,
    AssignMerchants: assignMerchants,
    GetOrdersById: getOrdersById,
    IssueCashbackCredit: issueCashbackCredit,
};
