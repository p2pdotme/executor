import type { ExecutorConfig } from '../helpers/config';
import { PrizerailStore } from './store';

// One pool per process, shared by the entry worker, the scanner and the
// payout worker. Created lazily so a deploy without the programme never
// opens a database connection.
let store: PrizerailStore | undefined;

export function getPrizerailStore(config: ExecutorConfig): PrizerailStore {
    if (!config.prizerail) {
        throw new Error('prizerail store requested but PRIZERAIL_API_KEY is unset');
    }
    if (!store) store = new PrizerailStore(config.prizerail.databaseUrl);
    return store;
}
