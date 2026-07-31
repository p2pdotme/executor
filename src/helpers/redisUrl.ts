import { logger } from './logger';

/**
 * Guard on the Redis connection string.
 *
 * Redis holds the BullMQ queues and the tracked-order set — no key material —
 * but write access to it is still write access to the executor's work: an
 * attacker who can reach an open instance can enqueue, drop or replay jobs for
 * a service that signs transactions. The queue store must therefore be either
 * on a private network or authenticated, and credentials must not cross a
 * public network in cleartext.
 *
 * The check fails the boot rather than warning, because an unauthenticated
 * Redis is exactly the kind of default that survives to production unnoticed.
 * `ALLOW_INSECURE_REDIS=true` is the deliberate, documented escape hatch.
 */

const PRIVATE_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', 'redis']);

/** Docker-compose service names, Railway private networking, k8s cluster DNS. */
const PRIVATE_SUFFIXES = ['.internal', '.local', '.localhost', '.svc.cluster.local'];

function isPrivateHost(hostname: string): boolean {
    const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (PRIVATE_HOSTNAMES.has(host)) return true;
    if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
    // Bare single-label hostnames only resolve inside a container/overlay network.
    if (!host.includes('.') && !host.includes(':')) return true;
    // RFC1918 + loopback + link-local IPv4, and IPv6 unique-local.
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    if (/^127\./.test(host)) return true;
    if (/^169\.254\./.test(host)) return true;
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
    return false;
}

export function assertSafeRedisUrl(rawUrl: string): void {
    let url: URL;
    try {
        url = new URL(rawUrl);
    } catch {
        throw new Error('REDIS_URL is not a valid URL');
    }

    const override = process.env.ALLOW_INSECURE_REDIS === 'true';
    const tls = url.protocol === 'rediss:';
    const authenticated = url.password !== '';
    const priv = isPrivateHost(url.hostname);

    const fail = (problem: string, fix: string) => {
        if (override) {
            logger.warn(`[redis] ${problem} — allowed by ALLOW_INSECURE_REDIS=true. ${fix}`);
            return;
        }
        throw new Error(`[redis] ${problem}. ${fix} Set ALLOW_INSECURE_REDIS=true to override.`);
    };

    if (!authenticated && !priv) {
        fail(
            `REDIS_URL points at the non-private host "${url.hostname}" with no password`,
            'Use an authenticated rediss:// URL, or move Redis onto the private network.',
        );
        return;
    }

    if (!tls && !priv) {
        fail(
            `REDIS_URL sends credentials in cleartext to the non-private host "${url.hostname}"`,
            'Use rediss:// so the connection is TLS-protected.',
        );
        return;
    }

    if (!authenticated) {
        logger.warn(
            `[redis] connecting to "${url.hostname}" without a password. This is acceptable only because the host is private — set requirepass and put the password in REDIS_URL.`,
        );
    }
}
