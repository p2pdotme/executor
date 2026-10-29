export const PRIZERAIL_PROD_BASE_URL = 'https://www.prizerail.com/api/v1';
export const PRIZERAIL_SANDBOX_BASE_URL = 'https://sandbox.prizerail.com/api/v1';

const SANDBOX_KEY_PREFIX = 'pr_sandbox_';
const PROD_KEY_PREFIX = 'pr_prod_';
const MIN_HMAC_KEY_LENGTH = 16;
const DEFAULT_PAYOUT_SCAN_INTERVAL_MIN = 30;
const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export type PrizerailConfig = {
    apiKey: string;
    campaignSlug: string;
    baseUrl: string;
    isSandbox: boolean;
    // Secret for the entrant-id HMAC. Fixed for the campaign's life — see
    // prizerail/entries.ts.
    entrantHmacKey: string;
    // Winner discovery is opt-in: it only ledgers + alerts, never pays. The
    // payout rail is a separate decision (see README), so it ships off.
    payoutScanEnabled: boolean;
    payoutScanIntervalMin: number;
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

function parseScanInterval(env: Env): number {
    const raw = trimmed(env, 'PRIZERAIL_PAYOUT_SCAN_INTERVAL_MIN');
    if (!raw) return DEFAULT_PAYOUT_SCAN_INTERVAL_MIN;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) {
        throw new Error('PRIZERAIL_PAYOUT_SCAN_INTERVAL_MIN must be an integer >= 1');
    }
    return n;
}

/**
 * Parse the Prizerail programme env. Returns null when PRIZERAIL_API_KEY is
 * unset so the executor stays usable for deploys that do not run the draw.
 * Once the key is set, every other field is validated and a bad value fails
 * the boot rather than silently dropping entries.
 */
export function loadPrizerailConfig(env: Env): PrizerailConfig | null {
    const apiKey = trimmed(env, 'PRIZERAIL_API_KEY');
    if (!apiKey) return null;

    const isSandbox = apiKey.startsWith(SANDBOX_KEY_PREFIX);
    if (!isSandbox && !apiKey.startsWith(PROD_KEY_PREFIX)) {
        throw new Error(
            `PRIZERAIL_API_KEY must start with ${SANDBOX_KEY_PREFIX} or ${PROD_KEY_PREFIX}`,
        );
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
        throw new Error(
            `PRIZERAIL_ENTRANT_HMAC_KEY must be at least ${MIN_HMAC_KEY_LENGTH} characters`,
        );
    }

    return {
        apiKey,
        campaignSlug,
        baseUrl: parseBaseUrl(env, isSandbox),
        isSandbox,
        entrantHmacKey,
        payoutScanEnabled: trimmed(env, 'PRIZERAIL_PAYOUT_SCAN_ENABLED') === 'true',
        payoutScanIntervalMin: parseScanInterval(env),
    };
}
