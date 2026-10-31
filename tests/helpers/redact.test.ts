import { describe, expect, test } from 'bun:test';
import { redactError, redactSecrets, secretsFromEnv } from '../../src/helpers/redact';

const KEY = 'FAKEKEY_abc123XYZ';
// The exact shape ethers v6 produces for a failed JSON-RPC call.
const ETHERS_MSG =
    `server response 401 Unauthorized (request={  }, response={  }, error=null, info={ "requestUrl": "https://base-mainnet.g.alchemy.com/v2/${KEY}", "responseBody": "{\\"error\\":{\\"message\\":\\"Must be authenticated!\\"}}" }, code=SERVER_ERROR, version=6.15.0)`;

describe('redactSecrets', () => {
    test('strips an Alchemy key from an ethers error even when it is not a known secret', () => {
        const out = redactSecrets(ETHERS_MSG, []);
        expect(out).not.toContain(KEY);
        expect(out).toContain('/v2/[redacted]');
        expect(out).toContain('Must be authenticated!');
    });

    test('replaces known secret values wherever they appear', () => {
        expect(redactSecrets(`key=${KEY} again ${KEY}`, [KEY])).toBe('key=[redacted] again [redacted]');
    });

    test('hides a password embedded in a connection string', () => {
        expect(redactSecrets('connect ECONNREFUSED postgres://app:s3cret@db.internal:5432/x', [])).toBe(
            'connect ECONNREFUSED postgres://app:[redacted]@db.internal:5432/x',
        );
    });

    test('leaves ordinary text and tx hashes alone', () => {
        const msg = 'payout tx 0x' + 'ab'.repeat(32) + ' still pending';
        expect(redactSecrets(msg, [])).toBe(msg);
    });
});

describe('secretsFromEnv', () => {
    test('collects secret-looking env vars, longest first, and ignores short or unrelated values', () => {
        const secrets = secretsFromEnv({
            ALCHEMY_API_KEY: KEY,
            PRIZE_PAYOUT_EXECUTOR: '0x' + 'a'.repeat(64),
            DISCORD_ONFAIL_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc',
            DATABASE_URL: 'postgres://u:p@h/db',
            DRY_RUN: 'true',
            SHORT_KEY: 'abc',
            PATH: '/usr/bin',
        });
        expect(secrets[0]).toBe('0x' + 'a'.repeat(64));
        expect(secrets).toContain(KEY);
        expect(secrets).toContain('https://discord.com/api/webhooks/1/abc');
        expect(secrets).not.toContain('true');
        expect(secrets).not.toContain('abc');
        expect(secrets).not.toContain('/usr/bin');
    });
});

describe('redactError', () => {
    test('uses the message of an Error and the string form of anything else', () => {
        expect(redactError(new Error(`bad ${KEY}`), [KEY])).toBe('bad [redacted]');
        expect(redactError(`plain ${KEY}`, [KEY])).toBe('plain [redacted]');
        expect(redactError(undefined, [])).toBe('undefined');
    });
});
