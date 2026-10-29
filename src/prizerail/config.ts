export const PRIZERAIL_PROD_BASE_URL = 'https://www.prizerail.com/api/v1';
export const PRIZERAIL_SANDBOX_BASE_URL = 'https://sandbox.prizerail.com/api/v1';

const SANDBOX_KEY_PREFIX = 'pr_sandbox_';
const PROD_KEY_PREFIX = 'pr_prod_';
const MIN_HMAC_KEY_LENGTH = 16;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

// USDC contract per chain id. Resolved from the RPC's chain at startup, so
// the same build pays in the right token on mainnet and on Sepolia without
// an env knob. Add a chain here if the executor ever runs elsewhere.
export const USDC_BY_CHAIN_ID: Readonly<Record<number, string>> = {
    8453: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base mainnet — Circle USDC
    84532: '0x696F33A6F975336f117083bB42B2fF7ab79B6b14', // Base Sepolia — the test USDC the Diamond + app use
};

export function resolveUsdcAddress(chainId: number): string {
    const address = USDC_BY_CHAIN_ID[chainId];
    if (!address) {
        throw new Error(`No USDC address known for chain id ${chainId} — add it to USDC_BY_CHAIN_ID in prizerail/config.ts`);
    }
    return address;
}

// Programme policy. These are product rules, not deployment facts, so they
// live here rather than in env: change them in code, with a review.
export const PRIZERAIL_POLICY = {
    // How often the scanner reads settled/paid drawings and queues payouts.
    payoutScanIntervalMin: 5,
    // Prizes at or above this many US cents are never auto-paid and wait
    // for a human ('held'). 2000 = $20. Well under Prizerail's $600
    // identity-check threshold, so no auto-paid winner can ever need KYC.
    maxAutoPayoutCents: 2_000,
    // Balance-channel alert when a payout would leave the prize wallet
    // below this many USDC.
    prizeWalletMinUsdc: 100,
} as const;

export type PrizerailConfig = {
    apiKey: string;
    campaignSlug: string;
    baseUrl: string;
    isSandbox: boolean;
    // Secret for the entrant-id HMAC. Fixed for the campaign's life — see
    // prizerail/entries.ts.
    entrantHmacKey: string;
    // Postgres for the entrant map and the winner/payout ledger. Required
    // whenever the programme is on: this is the record of money owed.
    databaseUrl: string;
    // Automatic USDC payout from the prize wallet. On exactly when
    // PRIZE_PAYOUT_EXECUTOR (the wallet key) is set — the presence of the key
    // is the switch, like the other optional features. The USDC contract is
    // resolved from the chain id (USDC_BY_CHAIN_ID), not configured.
    payoutEnabled: boolean;
};

type Env = Record<string, string | undefined>;

function trimmed(env: Env, name: string): string {
    return (env[name] ?? '').trim();
}

function parseBaseUrl(env: Env, isSandbox: boolean): string {
    const explicit = trimmed(env, 'PRIZERAIL_BASE_URL');
    const url = explicit || (isSandbox ? PRIZERAIL_SANDBOX_BASE_URL : PRIZERAIL_PROD_BASE_URL);
    if (!/^https:\/\//.test(url)) {
        throw new Error('PRIZERAIL_BASE_URL must be an https URL');
    }
    return url.replace(/\/+$/, '');
}

/**
 * Parse the Prizerail programme env. Returns null when PRIZERAIL_API_KEY is
 * unset so the executor stays usable for deploys that do not run the draw.
 * Once the key is set, every other field is validated and a bad value fails
 * the boot rather than silently dropping entries or payouts.
 */
export function loadPrizerailConfig(env: Env): PrizerailConfig | null {
    const apiKey = trimmed(env, 'PRIZERAIL_API_KEY');
    if (!apiKey) return null;

    const isSandbox = apiKey.startsWith(SANDBOX_KEY_PREFIX);
    if (!isSandbox && !apiKey.startsWith(PROD_KEY_PREFIX)) {
        throw new Error(`PRIZERAIL_API_KEY must start with ${SANDBOX_KEY_PREFIX} or ${PROD_KEY_PREFIX}`);
    }

    const campaignSlug = trimmed(env, 'PRIZERAIL_CAMPAIGN_SLUG');
    if (!campaignSlug || !SLUG_PATTERN.test(campaignSlug)) {
        throw new Error('PRIZERAIL_CAMPAIGN_SLUG is required and must be a lowercase slug');
    }

    const entrantHmacKey = trimmed(env, 'PRIZERAIL_ENTRANT_HMAC_KEY');
    if (!entrantHmacKey) {
        throw new Error('PRIZERAIL_ENTRANT_HMAC_KEY is required when PRIZERAIL_API_KEY is set');
    }
    if (entrantHmacKey.length < MIN_HMAC_KEY_LENGTH) {
        throw new Error(`PRIZERAIL_ENTRANT_HMAC_KEY must be at least ${MIN_HMAC_KEY_LENGTH} characters`);
    }

    const databaseUrl = trimmed(env, 'DATABASE_URL');
    if (!/^postgres(ql)?:\/\//.test(databaseUrl)) {
        throw new Error('DATABASE_URL (postgres://…) is required when PRIZERAIL_API_KEY is set');
    }

    return {
        apiKey,
        campaignSlug,
        baseUrl: parseBaseUrl(env, isSandbox),
        isSandbox,
        entrantHmacKey,
        databaseUrl,
        payoutEnabled: !!trimmed(env, 'PRIZE_PAYOUT_EXECUTOR'),
    };
}
