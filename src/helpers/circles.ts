import { decodeBytes32String } from 'ethers';
import { ExecutorConfig } from './config';
import { logger } from './logger';
import { connection } from '../queue';

// Last known good registry. Redis, not a file: the executor has no volume
// (WORKDIR /app), so anything written to disk is lost on the next redeploy.
const CACHE_KEY = 'executor:circle-currencies';
const FETCH_TIMEOUT_MS = 10_000;

// Circle ids are `++circleIdCounter`, so this ceiling is the total number of
// circles the protocol will ever have queried in one page. Well clear of the
// current 16 and of the subgraph's 1000-row limit.
const CIRCLES_QUERY = `
  query Circles {
    circles(first: 1000, orderBy: circleId, orderDirection: asc) {
      currency
    }
  }
`;

type CircleRow = { currency: string };

/** bytes32 → ASCII code, skipping anything that isn't a plausible symbol. */
function decodeCurrencies(rows: CircleRow[]): string[] {
    const out = new Set<string>();
    for (const row of rows) {
        let code: string;
        try {
            code = decodeBytes32String(row.currency).toUpperCase();
        } catch {
            logger.warn(`circle registry: undecodable currency ${row.currency} — skipping`);
            continue;
        }
        if (!/^[A-Z]{2,8}$/.test(code)) {
            logger.warn(`circle registry: implausible currency "${code}" — skipping`);
            continue;
        }
        out.add(code);
    }
    if (out.size === 0) throw new Error('no decodable currencies in circles[]');
    return [...out];
}

/** The cached registry without touching the network, or null if never populated. */
export async function readCachedCurrencies(): Promise<string[] | null> {
    const cached = await connection.get(CACHE_KEY).catch(() => null);
    if (!cached) return null;
    try {
        return JSON.parse(cached) as string[];
    } catch {
        return null;
    }
}

/**
 * The currencies the protocol actually runs circles for.
 *
 * Read from the subgraph rather than enumerated on-chain or fetched from the
 * notifier: every other read in the daily keeper already comes from here, so
 * this adds no new dependency — a keeper run cannot do anything useful with
 * the subgraph down anyway. Sourcing it from the notifier instead would mean
 * both services had to be up, and would tie the sweep to whether Discord
 * provisioning happened to succeed.
 *
 * On any failure this falls back to the last successful response cached in
 * Redis, so a subgraph blip degrades to a slightly stale list rather than
 * skipping whole currencies. With no cache and no subgraph, it throws — the
 * caller must not silently proceed against an empty set.
 */
export async function fetchCircleCurrencies(config: ExecutorConfig): Promise<string[]> {
    if (!config.subgraphUrl) {
        throw new Error('SUBGRAPH_URL not set — cannot resolve circle currencies');
    }

    try {
        const res = await fetch(config.subgraphUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: CIRCLES_QUERY }),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!res.ok) throw new Error(`subgraph ${res.status}`);
        const json = (await res.json()) as { data?: { circles?: CircleRow[] }; errors?: unknown };
        if (json.errors) throw new Error(`subgraph errors: ${JSON.stringify(json.errors)}`);
        if (!Array.isArray(json.data?.circles)) throw new Error('missing circles[]');

        const currencies = decodeCurrencies(json.data.circles);
        await connection.set(CACHE_KEY, JSON.stringify(currencies));
        return currencies;
    } catch (err: any) {
        const cached = await readCachedCurrencies();
        if (!cached) throw new Error(`circle registry unreachable and no cached copy: ${err?.message ?? err}`);
        logger.warn(
            `circle registry fetch failed (${err?.message ?? err}) — falling back to ${cached.length} cached currencies`,
        );
        return cached;
    }
}
