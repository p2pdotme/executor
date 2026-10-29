import { describe, expect, test } from 'bun:test';
import {
    isCurrencyExcluded,
    loadPrizerailConfig,
    PRIZERAIL_SITES,
    PRIZERAIL_POLICY,
    PRIZERAIL_PROD_BASE_URL,
    PRIZERAIL_SANDBOX_BASE_URL,
    resolveUsdcAddress,
} from '../../src/prizerail/config';

const VALID = {
    PRIZERAIL_API_KEY: 'pr_sandbox_abc123',
    PRIZERAIL_ENTRANT_HMAC_KEY: 'a-sufficiently-long-secret-value',
    DATABASE_URL: 'postgres://u:p@localhost:5432/executor',
};

describe('loadPrizerailConfig', () => {
    test('returns null when the API key is unset', () => {
        expect(loadPrizerailConfig({})).toBeNull();
        expect(loadPrizerailConfig({ PRIZERAIL_API_KEY: '   ' })).toBeNull();
    });

    test('a sandbox key selects the sandbox site: its base URL and Base Sepolia', () => {
        const cfg = loadPrizerailConfig(VALID);
        expect(cfg?.site).toBe('sandbox');
        expect(cfg?.baseUrl).toBe(PRIZERAIL_SANDBOX_BASE_URL);
        expect(cfg?.isSandbox).toBe(true);
        expect(cfg?.chainId).toBe(84532);
    });

    test('a prod key selects production: its base URL and Base mainnet', () => {
        const cfg = loadPrizerailConfig({ ...VALID, PRIZERAIL_API_KEY: 'pr_prod_xyz' });
        expect(cfg?.site).toBe('prod');
        expect(cfg?.baseUrl).toBe(PRIZERAIL_PROD_BASE_URL);
        expect(cfg?.isSandbox).toBe(false);
        expect(cfg?.chainId).toBe(8453);
    });

    test('rejects an unknown key prefix', () => {
        expect(() => loadPrizerailConfig({ ...VALID, PRIZERAIL_API_KEY: 'sk_live_nope' })).toThrow(
            /PRIZERAIL_API_KEY/,
        );
    });

    test('production excludes INR, VEN and BOB; the sandbox excludes nothing', () => {
        const prod = loadPrizerailConfig({ ...VALID, PRIZERAIL_API_KEY: 'pr_prod_xyz' })!;
        for (const code of ['INR', 'VEN', 'BOB', 'inr ']) expect(isCurrencyExcluded(prod, code)).toBe(true);
        for (const code of ['ARS', 'MEX', 'BRL', 'NGN', '']) expect(isCurrencyExcluded(prod, code)).toBe(false);
        const sandbox = loadPrizerailConfig(VALID)!;
        expect(isCurrencyExcluded(sandbox, 'INR')).toBe(false);
    });

    test('the campaign comes from the site, never from env', () => {
        expect(loadPrizerailConfig(VALID)?.campaignSlug).toBe(PRIZERAIL_SITES.sandbox.campaignSlug);
        expect(loadPrizerailConfig({ ...VALID, PRIZERAIL_API_KEY: 'pr_prod_xyz' })?.campaignSlug).toBe(
            PRIZERAIL_SITES.prod.campaignSlug,
        );
        expect(PRIZERAIL_SITES.prod.campaignSlug).toBe('p2p-ramp');
        expect(PRIZERAIL_SITES.sandbox.campaignSlug).toBe('p2pme-p2pdotme-orders');
        expect(
            loadPrizerailConfig({ ...VALID, PRIZERAIL_CAMPAIGN_SLUG: 'something-else' })?.campaignSlug,
        ).toBe(PRIZERAIL_SITES.sandbox.campaignSlug);
    });

    test('requires the HMAC key once the API key is set', () => {
        expect(() => loadPrizerailConfig({ PRIZERAIL_API_KEY: VALID.PRIZERAIL_API_KEY })).toThrow(
            /PRIZERAIL_ENTRANT_HMAC_KEY/,
        );
    });

    test('rejects a short HMAC key', () => {
        expect(() => loadPrizerailConfig({ ...VALID, PRIZERAIL_ENTRANT_HMAC_KEY: 'short' })).toThrow(
            /at least/,
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
