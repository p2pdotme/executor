import { decodeBytes32String } from 'ethers';

const BPS_DENOMINATOR = 10_000n;

export type CashbackRates = {
    cashbackBps: number;
    cashbackBpsByCurrency: Record<string, number>;
};

// Decode the order's bytes32 currency into its symbol (e.g. "ARS"). Returns
// '' when the field is empty/unset or not a valid bytes32 string so callers
// can safely fall back to the default rate.
export function decodeCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !currency) return '';
    try {
        return decodeBytes32String(currency).trim().toUpperCase();
    } catch {
        return '';
    }
}

// Resolve the rate for an order: a per-currency override when one is
// configured for the order's currency, otherwise the default.
export function resolveCashbackBps(rates: CashbackRates, currencyCode: string): number {
    if (currencyCode && currencyCode in rates.cashbackBpsByCurrency) {
        return rates.cashbackBpsByCurrency[currencyCode];
    }
    return rates.cashbackBps;
}

// True when at least one positive rate exists — the default or any override.
// An operator may zero the default but still credit a single market.
export function anyRatePositive(rates: CashbackRates): boolean {
    return rates.cashbackBps > 0 || Object.values(rates.cashbackBpsByCurrency).some((bps) => bps > 0);
}

export function computeCashback(amountUsdc6: bigint, bps: number): bigint {
    return (amountUsdc6 * BigInt(bps)) / BPS_DENOMINATOR;
}
