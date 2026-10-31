// Keeps secrets out of Discord alerts and the Prizerail ledger's last_error
// column. ethers v6 puts the full request URL into error messages
// (`info={ "requestUrl": "https://…/v2/<ALCHEMY KEY>" }`), and other
// libraries embed credentials in URLs the same way, so every message that
// leaves the process goes through here first.

const REDACTED = '[redacted]';
const MIN_SECRET_LENGTH = 8;

// Env vars whose values are secrets. Matched by suffix so a new wallet key
// or webhook is covered without editing this list.
const SECRET_ENV_NAME = /(_KEY|_SECRET|_TOKEN|_EXECUTOR|_WEBHOOK_URL|DATABASE_URL|RPC_HTTP_URL|RPC_WS_URL)$/;

// Shapes that carry a credential whatever its value is.
const SECRET_PATTERNS: readonly { pattern: RegExp; replacement: string }[] = [
    // Alchemy-style key in the URL path: https://base-mainnet.g.alchemy.com/v2/<key>
    { pattern: /(\/v2\/)[A-Za-z0-9_-]{8,}/g, replacement: `$1${REDACTED}` },
    // Basic-auth user info in a URL: postgres://user:password@host
    { pattern: /(:\/\/[^\s/@:]+:)[^\s@/]+(@)/g, replacement: `$1${REDACTED}$2` },
];

type Env = Record<string, string | undefined>;

/** Values of every secret-looking env var, longest first so a value that contains another is replaced whole. */
export function secretsFromEnv(env: Env = process.env): string[] {
    const values = Object.entries(env)
        .filter(([name, value]) => SECRET_ENV_NAME.test(name) && (value ?? '').trim().length >= MIN_SECRET_LENGTH)
        .map(([, value]) => (value as string).trim());
    return [...new Set(values)].sort((a, b) => b.length - a.length);
}

/** Replace known secret values and credential-shaped substrings in `text`. */
export function redactSecrets(text: string, secrets: readonly string[] = secretsFromEnv()): string {
    const bySecret = secrets.reduce((acc, secret) => acc.split(secret).join(REDACTED), text);
    return SECRET_PATTERNS.reduce((acc, { pattern, replacement }) => acc.replace(pattern, replacement), bySecret);
}

/** An error's message, redacted. Safe to put in an alert or the ledger. */
export function redactError(err: unknown, secrets?: readonly string[]): string {
    const message = err instanceof Error ? err.message : String(err);
    return redactSecrets(message, secrets);
}
