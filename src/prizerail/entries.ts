import { createHmac } from 'crypto';

// Prizerail accepts `entries` as an integer in [1, 4_294_967_295] (uint32).
export const MAX_ENTRIES = 4_294_967_295;

// USDC has 6 decimals; one cent is 10^4 base units.
const USDC_UNITS_PER_CENT = 10_000n;

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
 * One draw entry per cent of the cashback-equivalent amount. Reusing the
 * cashback figure (order amount × bps) keeps the per-currency rates meaningful:
 * an ARS order at 1% earns half the entries of a default-rate order of the
 * same size, exactly as it earned half the credit before.
 */
export function entriesFromCashbackUsdc(cashbackUsdc6: bigint): number {
    if (cashbackUsdc6 <= 0n) return 0;
    const cents = cashbackUsdc6 / USDC_UNITS_PER_CENT;
    if (cents > BigInt(MAX_ENTRIES)) return MAX_ENTRIES;
    return Number(cents);
}
