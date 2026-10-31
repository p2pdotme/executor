import { sendOnFail } from '../helpers/alerts';
import type { ExecutorConfig } from '../helpers/config';
import { logger } from '../helpers/logger';
import { getPrizerailStore } from './db';

export type PrizerailBootDeps = {
    applySchema: () => Promise<void>;
    alert: (message: string) => Promise<void>;
};

/**
 * Applies the Prizerail ledger schema (idempotent, every boot, so a fresh
 * database needs no manual migration). Prizerail is optional: if Postgres is
 * down the programme is turned off for this run and the returned config has
 * `prizerail: null`, so assign, sweeper and keepers still start.
 */
export async function initPrizerail(
    config: ExecutorConfig,
    deps: PrizerailBootDeps = {
        applySchema: () => getPrizerailStore(config).applySchema(),
        alert: (m) => sendOnFail(config, m),
    },
): Promise<ExecutorConfig> {
    if (!config.prizerail) return config;
    try {
        await deps.applySchema();
        logger.info('prizerail: postgres schema applied');
        return config;
    } catch (err: unknown) {
        const msg = `prizerail: Postgres unavailable at boot (${(err as Error)?.message ?? err}) — Prizerail is OFF until restart; orders completed meanwhile earn no entries`;
        logger.error(msg);
        await deps.alert(`⚠️ ${msg}`).catch(() => {});
        return { ...config, prizerail: null };
    }
}
