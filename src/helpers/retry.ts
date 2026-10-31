export type RetryOptions = {
    /** Total attempts, including the first. */
    attempts: number;
    /** Delay before the second attempt; doubles on each later one. */
    baseDelayMs: number;
    onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn` until it resolves or `attempts` is used up, backing off
 * exponentially between tries. The last error is rethrown unchanged.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    opts: RetryOptions,
    sleep: (ms: number) => Promise<void> = defaultSleep,
): Promise<T> {
    const attempts = Math.max(1, Math.floor(opts.attempts));
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await fn();
        } catch (err: unknown) {
            lastError = err;
            if (attempt === attempts) break;
            const delayMs = opts.baseDelayMs * 2 ** (attempt - 1);
            opts.onRetry?.(err, attempt, delayMs);
            await sleep(delayMs);
        }
    }
    throw lastError;
}
