import { describe, expect, test } from 'bun:test';
import { withRetry } from '../../src/helpers/retry';

const noSleep = async () => {};

describe('withRetry', () => {
    test('returns the first success without sleeping', async () => {
        let calls = 0;
        const slept: number[] = [];
        const out = await withRetry(async () => ++calls, { attempts: 3, baseDelayMs: 100 }, async (ms) => {
            slept.push(ms);
        });
        expect(out).toBe(1);
        expect(slept).toEqual([]);
    });

    test('retries with exponential backoff and succeeds on a later attempt', async () => {
        let calls = 0;
        const slept: number[] = [];
        const retries: number[] = [];
        const out = await withRetry(
            async () => {
                calls += 1;
                if (calls < 3) throw new Error(`fail ${calls}`);
                return 'ok';
            },
            { attempts: 3, baseDelayMs: 100, onRetry: (_e, attempt) => retries.push(attempt) },
            async (ms) => {
                slept.push(ms);
            },
        );
        expect(out).toBe('ok');
        expect(slept).toEqual([100, 200]);
        expect(retries).toEqual([1, 2]);
    });

    test('rethrows the last error once attempts are used up', async () => {
        let calls = 0;
        await expect(
            withRetry(
                async () => {
                    calls += 1;
                    throw new Error(`fail ${calls}`);
                },
                { attempts: 3, baseDelayMs: 1 },
                noSleep,
            ),
        ).rejects.toThrow('fail 3');
        expect(calls).toBe(3);
    });

    test('attempts below one still run the function once', async () => {
        let calls = 0;
        await withRetry(async () => ++calls, { attempts: 0, baseDelayMs: 1 }, noSleep);
        expect(calls).toBe(1);
    });
});
