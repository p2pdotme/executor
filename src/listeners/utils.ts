import { Contract, ethers, Interface } from 'ethers';
import { DIAMOND_ABI } from '../helpers/abi';
import { logger } from '../helpers/logger';

export const currencyMap: Record<string, string> = {
    [ethers.encodeBytes32String("INR")]: "Inr",
    [ethers.encodeBytes32String("IDR")]: "Idr",
    [ethers.encodeBytes32String("BRL")]: "Brl",
    [ethers.encodeBytes32String("ARS")]: "Ars",
};

const MERCHANT_ASSIGNED_EVENT = 'MerchantAssignedNewOrder';

// fetch merchant addresses from tx hash
export async function getMerchantAddressesFromTx(
    provider: any,
    txHash: string,
    diamondAddress: string,
): Promise<string[]> {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) {
        logger.warn({ txHash }, 'getMerchantAddressesFromTx: no receipt found');
        return [];
    }

    const iface = new Interface(DIAMOND_ABI);
    const merchants: string[] = [];

    for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== diamondAddress.toLowerCase()) continue;

        try {
            const parsed = iface.parseLog({
                topics: log.topics,
                data: log.data,
            });

            if (parsed && parsed.name === MERCHANT_ASSIGNED_EVENT) {
                const merchantAddr = String(parsed.args.merchant);
                merchants.push(merchantAddr);
            }
        } catch {
            // skip logs that don't match any event in DIAMOND_ABI
            continue;
        }
    }

    return merchants;
}

// Resolve order object: prefer _order from event, otherwise call getOrdersById(id).
export const resolveOrderFromEventOrChain = async (
    parsed: { args?: any },
    diamond: Contract
): Promise<any | null> => {
    if (!parsed?.args) return null;

    const maybeOrder = parsed.args._order ?? null;
    if (maybeOrder && maybeOrder.id !== undefined && maybeOrder.id !== null) {
        return maybeOrder;
    }

    const id = parsed.args?.orderId ?? parsed.args?.[0] ?? null;
    if (!id) return null;

    try {
        return await diamond.getOrdersById(id);
    } catch (err: any) {
        logger.warn(`⚠️ resolveOrderFromEventOrChain: getOrdersById failed: ${err?.message}`);
        return null;
    }
};
