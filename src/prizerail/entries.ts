import { createHmac } from 'crypto';

// Prizerail accepts `entries` as an integer in [1, 4_294_967_295] (uint32).
export const MAX_ENTRIES = 4_294_967_295;

// Entry rate anchor: at this bps an order earns ONE entry per whole USDC.
// A market on half this rate earns half an entry per dollar; 0 bps earns
// nothing. Keeping the per-market bps as the dial means the production
// CASHBACK_BPS_BY_CURRENCY overrides keep working unchanged.
export const BPS_PER_ENTRY_PER_USDC = 200n;
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
 * Draw entries for an order: whole USDC × (bps / 200). At the 2% default a
 * $50 order earns 50 entries; a market overridden to 1% earns 25. Proportional to
 * value, so splitting an order into smaller ones changes nothing.
 */
export function entriesForOrder(amountUsdc6: bigint, bps: number): number {
    if (amountUsdc6 <= 0n || !Number.isInteger(bps) || bps <= 0) return 0;
    const entries = (amountUsdc6 * BigInt(bps)) / (BPS_PER_ENTRY_PER_USDC * USDC_UNITS);
    if (entries > BigInt(MAX_ENTRIES)) return MAX_ENTRIES;
    return Number(entries);
}
