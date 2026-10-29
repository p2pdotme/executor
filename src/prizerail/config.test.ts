import { describe, expect, test } from 'bun:test';
import {
    loadPrizerailConfig,
    PRIZERAIL_POLICY,
    PRIZERAIL_PROD_BASE_URL,
    PRIZERAIL_SANDBOX_BASE_URL,
    resolveUsdcAddress,
} from './config';

const VALID = {
    PRIZERAIL_API_KEY: 'pr_sandbox_abc123',
    PRIZERAIL_CAMPAIGN_SLUG: 'p2p-daily',
    PRIZERAIL_ENTRANT_HMAC_KEY: 'a-sufficiently-long-secret-value',
    DATABASE_URL: 'postgres://u:p@localhost:5432/executor',
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

    test('requires DATABASE_URL once the programme is on', () => {
        expect(() => loadPrizerailConfig({ ...VALID, DATABASE_URL: '' })).toThrow(/DATABASE_URL/);
        expect(() => loadPrizerailConfig({ ...VALID, DATABASE_URL: 'mysql://x' })).toThrow(/DATABASE_URL/);
    });

    test('payout is on exactly when the prize wallet key is set', () => {
        expect(loadPrizerailConfig(VALID)?.payoutEnabled).toBe(false);
        expect(loadPrizerailConfig({ ...VALID, PRIZE_PAYOUT_EXECUTOR: '0x' + 'a'.repeat(64) })?.payoutEnabled).toBe(true);
    });

    test('USDC is resolved from the chain id, not env', () => {
        expect(resolveUsdcAddress(8453)).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
        expect(resolveUsdcAddress(84532)).toBe('0x696F33A6F975336f117083bB42B2fF7ab79B6b14');
        expect(() => resolveUsdcAddress(1)).toThrow(/chain id 1/);
    });

    test('policy lives in code, not env', () => {
        expect(PRIZERAIL_POLICY.maxAutoPayoutCents).toBe(2_000);
        expect(PRIZERAIL_POLICY.prizeWalletMinUsdc).toBe(100);
        expect(PRIZERAIL_POLICY.payoutScanIntervalMin).toBeGreaterThan(0);
    });
});
