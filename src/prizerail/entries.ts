import { createHmac } from 'crypto';

// Prizerail accepts `entries` as an integer in [1, 4_294_967_295] (uint32).
export const MAX_ENTRIES = 4_294_967_295;
const USDC_UNITS = 1_000_000n;

/**
 * Pseudonymous Prizerail entrant id for a wallet. Prizerail publishes the
 * hashed entrant list with every draw, so the id must not be derivable from
 * the wallet without the key. The key must stay fixed for the campaign's
 * whole life: guarantee draws count each person once per period, and a
 * rotated key would make the same wallet look like a new entrant.
 */
export function entrantIdFor(address: string, hmacKey: string): string {
    return createHmac('sha256', hmacKey).update(address.trim().toLowerCase()).digest('hex');
}

/**
 * Draw entries for an order: one per whole USDC. A $50 order earns 50, a
 * $0.90 order earns none. Proportional to value, so splitting an order into
 * smaller ones changes nothing. Markets that earn nothing are listed per site
 * in PRIZERAIL_SITES.excludedCurrencies, not expressed as a rate here.
 */
export function entriesForOrder(amountUsdc6: bigint): number {
    if (amountUsdc6 <= 0n) return 0;
    const entries = amountUsdc6 / USDC_UNITS;
    if (entries > BigInt(MAX_ENTRIES)) return MAX_ENTRIES;
    return Number(entries);
}

// On-chain currency code → country, for operator alerts. Codes that are not
// one country (USD, EUR) or are not listed here fall back to the code itself.
const COUNTRY_BY_CURRENCY: Readonly<Record<string, string>> = {
    ARS: 'Argentina',
    BOB: 'Bolivia',
    BRL: 'Brazil',
    COP: 'Colombia',
    ECU: 'Ecuador',
    EGP: 'Egypt',
    IDR: 'Indonesia',
    INR: 'India',
    KES: 'Kenya',
    MEX: 'Mexico',
    MXN: 'Mexico',
    NGN: 'Nigeria',
    PEN: 'Peru',
    PHP: 'Philippines',
    VEN: 'Venezuela',
    VES: 'Venezuela',
};

/** Discord line for entries counted on one order. Carries no wallet. */
export function formatEntryAlert(data: { orderId: string; entries: number; amountUsdc?: string; currency?: string }): string {
    const value = data.amountUsdc ? `${(Number(data.amountUsdc) / 1e6).toFixed(2)} USDC` : 'value n/a';
    const code = data.currency || 'n/a';
    const country = COUNTRY_BY_CURRENCY[code];
    return `🎟️ Prizerail entries: order ${data.orderId} · ${value} · ${country ? `${country} (${code})` : code} · ${data.entries} entries`;
}
