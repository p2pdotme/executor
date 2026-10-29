import { describe, expect, test } from 'bun:test';
import { loadPrizerailConfig, PRIZERAIL_PROD_BASE_URL, PRIZERAIL_SANDBOX_BASE_URL } from './config';

const VALID = {
    PRIZERAIL_API_KEY: 'pr_sandbox_abc123',
    PRIZERAIL_CAMPAIGN_SLUG: 'p2p-daily',
    PRIZERAIL_ENTRANT_HMAC_KEY: 'a-sufficiently-long-secret-value',
};

describe('loadPrizerailConfig', () => {
    test('returns null when the API key is unset', () => {
        expect(loadPrizerailConfig({})).toBeNull();
        expect(loadPrizerailConfig({ PRIZERAIL_API_KEY: '   ' })).toBeNull();
    });

    test('derives the sandbox base URL from a sandbox key', () => {
        const cfg = loadPrizerailConfig(VALID);
        expect(cfg?.baseUrl).toBe(PRIZERAIL_SANDBOX_BASE_URL);
        expect(cfg?.isSandbox).toBe(true);
    });

    test('derives the production base URL from a prod key', () => {
        const cfg = loadPrizerailConfig({ ...VALID, PRIZERAIL_API_KEY: 'pr_prod_xyz' });
        expect(cfg?.baseUrl).toBe(PRIZERAIL_PROD_BASE_URL);
        expect(cfg?.isSandbox).toBe(false);
    });

    test('honours an explicit base URL and strips trailing slashes', () => {
        const cfg = loadPrizerailConfig({ ...VALID, PRIZERAIL_BASE_URL: 'https://example.test/api/v1///' });
        expect(cfg?.baseUrl).toBe('https://example.test/api/v1');
    });

    test('rejects an unknown key prefix', () => {
        expect(() => loadPrizerailConfig({ ...VALID, PRIZERAIL_API_KEY: 'sk_live_nope' })).toThrow(
            /PRIZERAIL_API_KEY/,
        );
    });

    test('requires slug and HMAC key once the API key is set', () => {
        expect(() => loadPrizerailConfig({ PRIZERAIL_API_KEY: VALID.PRIZERAIL_API_KEY })).toThrow(
            /PRIZERAIL_CAMPAIGN_SLUG/,
        );
        expect(() =>
            loadPrizerailConfig({
                PRIZERAIL_API_KEY: VALID.PRIZERAIL_API_KEY,
                PRIZERAIL_CAMPAIGN_SLUG: 'p2p-daily',
            }),
        ).toThrow(/PRIZERAIL_ENTRANT_HMAC_KEY/);
    });

    test('rejects a short HMAC key', () => {
        expect(() => loadPrizerailConfig({ ...VALID, PRIZERAIL_ENTRANT_HMAC_KEY: 'short' })).toThrow(
            /at least/,
        );
    });

    test('rejects a malformed slug', () => {
        expect(() => loadPrizerailConfig({ ...VALID, PRIZERAIL_CAMPAIGN_SLUG: 'Bad Slug!' })).toThrow(
            /PRIZERAIL_CAMPAIGN_SLUG/,
        );
    });

    test('payout scan is off by default and parses its interval', () => {
        expect(loadPrizerailConfig(VALID)?.payoutScanEnabled).toBe(false);
        const on = loadPrizerailConfig({
            ...VALID,
            PRIZERAIL_PAYOUT_SCAN_ENABLED: 'true',
            PRIZERAIL_PAYOUT_SCAN_INTERVAL_MIN: '15',
        });
        expect(on?.payoutScanEnabled).toBe(true);
        expect(on?.payoutScanIntervalMin).toBe(15);
    });

    test('rejects a non-positive scan interval', () => {
        expect(() =>
            loadPrizerailConfig({ ...VALID, PRIZERAIL_PAYOUT_SCAN_INTERVAL_MIN: '0' }),
        ).toThrow(/PRIZERAIL_PAYOUT_SCAN_INTERVAL_MIN/);
    });
});
