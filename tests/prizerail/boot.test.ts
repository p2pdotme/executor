import { describe, expect, test } from 'bun:test';
import type { ExecutorConfig } from '../../src/helpers/config';
import { initPrizerail } from '../../src/prizerail/boot';

const PRIZERAIL = { campaignSlug: 'c' } as unknown as NonNullable<ExecutorConfig['prizerail']>;
const config = (prizerail: ExecutorConfig['prizerail']) => ({ prizerail }) as unknown as ExecutorConfig;

describe('initPrizerail', () => {
    test('programme off: touches nothing', async () => {
        const calls: string[] = [];
        const cfg = config(null);
        const out = await initPrizerail(cfg, {
            applySchema: async () => void calls.push('schema'),
            alert: async () => void calls.push('alert'),
        });
        expect(out).toBe(cfg);
        expect(calls).toEqual([]);
    });

    test('schema applied: keeps Prizerail on', async () => {
        const calls: string[] = [];
        const cfg = config(PRIZERAIL);
        const out = await initPrizerail(cfg, {
            applySchema: async () => void calls.push('schema'),
            alert: async () => void calls.push('alert'),
        });
        expect(out.prizerail).toBe(PRIZERAIL);
        expect(calls).toEqual(['schema']);
    });

    test('Postgres down: alerts and turns Prizerail off without throwing', async () => {
        const alerts: string[] = [];
        const cfg = config(PRIZERAIL);
        const out = await initPrizerail(cfg, {
            applySchema: async () => {
                throw new Error('connect ECONNREFUSED 127.0.0.1:5432');
            },
            alert: async (m) => void alerts.push(m),
        });
        expect(out.prizerail).toBeNull();
        expect(cfg.prizerail).toBe(PRIZERAIL); // input left untouched
        expect(alerts).toHaveLength(1);
        expect(alerts[0]).toContain('ECONNREFUSED');
    });

    test('a failing alert does not fail the boot', async () => {
        const out = await initPrizerail(config(PRIZERAIL), {
            applySchema: async () => {
                throw new Error('db down');
            },
            alert: async () => {
                throw new Error('discord down');
            },
        });
        expect(out.prizerail).toBeNull();
    });
});
