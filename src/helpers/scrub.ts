/**
 * Redaction for anything that leaves the process — Discord alerts and log
 * lines. Error strings from ethers, ky and ioredis routinely carry the URL
 * that produced them, and our RPC/webhook URLs have credentials embedded in
 * the path (`.../v2/<alchemy key>`, `/api/webhooks/<id>/<token>`). Without a
 * choke point, one upstream failure is enough to publish a live credential
 * into a Discord channel that is far less protected than the secret store.
 *
 * Redaction works off the *actual* secret values in the environment rather
 * than a shape heuristic: a 64-hex heuristic would eat every tx hash and
 * bytes32 order id in our alerts, while an exact-value match cannot produce a
 * false positive and keeps working when a key is rotated.
 */

/** Env vars whose value is secret. Suffix-matched so rotations/new keys are covered. */
const SECRET_ENV_SUFFIXES = ['_EXECUTOR', '_API_KEY', '_SECRET', '_TOKEN', 'WEBHOOK_URL', '_PASSWORD'];
/** Shorter values are not credential-shaped and redacting them would mangle output. */
const MIN_SECRET_LENGTH = 12;

/** Credentials in a URL authority, e.g. redis://default:pass@host:6379 */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:)[^\s/@]+@/gi;
/** Discord webhook token is the final path segment of the webhook URL */
const DISCORD_WEBHOOK = /(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[\w-]+/gi;
/** Provider RPC keys sit in the last path segment: /v2/<key> */
const RPC_KEY_PATH = /(\/v2\/)[A-Za-z0-9_-]{16,}/g;

let secrets: string[] | null = null;

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Collected lazily so import order never matters; call reset in tests. */
function knownSecrets(): string[] {
    if (secrets) return secrets;
    const found = new Set<string>();
    for (const [name, value] of Object.entries(process.env)) {
        if (!value || value.length < MIN_SECRET_LENGTH) continue;
        if (!SECRET_ENV_SUFFIXES.some((suffix) => name.endsWith(suffix))) continue;
        found.add(value.trim());
    }
    // Longest first so a secret containing another is masked whole.
    secrets = [...found].sort((a, b) => b.length - a.length);
    return secrets;
}

/** Drop the cached snapshot — only needed when env vars change at runtime. */
export function resetSecretCache(): void {
    secrets = null;
}

export function scrub(input: string): string {
    let out = input;
    for (const secret of knownSecrets()) {
        out = out.replace(new RegExp(escapeRegExp(secret), 'g'), '[redacted]');
    }
    return out
        .replace(URL_CREDENTIALS, '$1[redacted]@')
        .replace(DISCORD_WEBHOOK, '$1[redacted]')
        .replace(RPC_KEY_PATH, '$1[redacted]');
}

/** Scrub every string reachable from an arbitrary log/alert argument. */
export function scrubAny(value: unknown): unknown {
    if (typeof value === 'string') return scrub(value);
    if (Array.isArray(value)) return value.map(scrubAny);
    if (value instanceof Error) return scrub(value.stack ?? value.message);
    if (value && typeof value === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
            out[k] = scrubAny(v);
        }
        return out;
    }
    return value;
}
