import { z } from 'zod';
import { logger } from '../helpers/logger';
import {
    drawingSchema,
    drawingsPageEnvelopeSchema,
    errorBodySchema,
    incrementResponseSchema,
    PrizerailDrawing,
    PrizerailDrawingsPage,
    PrizerailDrawingStatus,
    PrizerailEntryEvent,
    PrizerailIncrementResponse,
} from './types';

export const MAX_ENTRANTS_PER_REQUEST = 1_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60_000;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type PrizerailClientOptions = {
    baseUrl: string;
    apiKey: string;
    campaignSlug: string;
    fetchImpl?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    timeoutMs?: number;
    // HTTP-level retries for 429/5xx/transport only. Callers that already
    // sit behind a job queue with its own backoff should keep this low.
    maxAttempts?: number;
};

export class PrizerailApiError extends Error {
    readonly status: number;
    readonly code: string;
    readonly retryable: boolean;

    constructor(message: string, status: number, code: string, retryable: boolean) {
        super(message);
        this.name = 'PrizerailApiError';
        this.status = status;
        this.code = code;
        this.retryable = retryable;
    }
}

type AttemptResult =
    | { ok: true; json: unknown }
    | { ok: false; error: PrizerailApiError; retryAfterMs: number | null };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function isRetryableStatus(status: number): boolean {
    return status === 429 || status >= 500;
}

function retryAfterMs(res: Response): number | null {
    const raw = res.headers.get('retry-after');
    if (!raw) return null;
    const secs = Number(raw);
    if (!Number.isFinite(secs) || secs < 0) return null;
    return Math.min(secs * 1000, MAX_RETRY_AFTER_MS);
}

async function errorFromResponse(res: Response): Promise<PrizerailApiError> {
    const text = await res.text().catch(() => '');
    let code = `http_${res.status}`;
    let detail = text.slice(0, 200);
    try {
        const body = errorBodySchema.parse(JSON.parse(text));
        code = body.code ?? code;
        detail = body.message ?? body.error ?? detail;
    } catch {
        // Non-JSON error body — keep the raw excerpt.
    }
    return new PrizerailApiError(
        `prizerail ${res.status} ${code}: ${detail}`,
        res.status,
        code,
        isRetryableStatus(res.status),
    );
}

// A 2xx whose body is not JSON is still a success; the body is only logged.
async function successBody(res: Response): Promise<unknown> {
    try {
        return await res.json();
    } catch {
        logger.warn(`prizerail: 2xx with a non-JSON body (${res.status}) — treating as success`);
        return {};
    }
}

/**
 * Minimal Prizerail REST client for the executor: send increment-mode entries
 * and read drawings. Retries only on 429 / 5xx / transport errors, honouring
 * Retry-After. Every other non-2xx is thrown as-is; deciding whether that is
 * worth a job-level retry is the caller's business (see prizerail/failures.ts).
 */
export class PrizerailClient {
    private readonly baseUrl: string;
    private readonly apiKey: string;
    private readonly campaignSlug: string;
    private readonly fetchImpl: FetchLike;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly timeoutMs: number;
    private readonly maxAttempts: number;

    constructor(opts: PrizerailClientOptions) {
        this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
        this.apiKey = opts.apiKey;
        this.campaignSlug = opts.campaignSlug;
        this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
        this.sleep = opts.sleep ?? defaultSleep;
        this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    }

    async sendIncrementEntries(events: readonly PrizerailEntryEvent[]): Promise<PrizerailIncrementResponse> {
        if (events.length === 0) throw new Error('prizerail: refusing to send an empty entrant batch');
        if (events.length > MAX_ENTRANTS_PER_REQUEST) {
            throw new Error(`prizerail: at most ${MAX_ENTRANTS_PER_REQUEST} entrants per request`);
        }
        const body = { mode: 'increment', entrants: events.map((e) => ({ ...e })) };
        const json = await this.request('POST', `/campaigns/${this.campaignSlug}/entries`, body);
        const parsed = incrementResponseSchema.safeParse(json);
        if (parsed.success) return parsed.data;
        // The POST succeeded; Prizerail has the entry. Never fail the caller
        // over a body we only log.
        logger.warn(`prizerail: entries response shape unexpected — ${issues(parsed.error)}`);
        return incrementResponseSchema.parse({});
    }

    async listDrawings(params: {
        status?: PrizerailDrawingStatus;
        limit?: number;
        before?: string;
    } = {}): Promise<PrizerailDrawingsPage> {
        const query = new URLSearchParams();
        if (params.status) query.set('status', params.status);
        if (params.limit !== undefined) query.set('limit', String(params.limit));
        if (params.before) query.set('before', params.before);
        const qs = query.toString();
        const json = await this.request('GET', `/campaigns/${this.campaignSlug}/drawings${qs ? `?${qs}` : ''}`);
        const envelope = parseOrThrow(drawingsPageEnvelopeSchema, json, 'drawings page');
        const drawings: PrizerailDrawing[] = [];
        let invalid = 0;
        for (const raw of envelope.drawings) {
            const d = drawingSchema.safeParse(raw);
            if (d.success) {
                drawings.push(d.data);
            } else {
                invalid += 1;
                logger.warn(`prizerail: skipping malformed drawing — ${issues(d.error)}`);
            }
        }
        return { drawings, invalid, nextBefore: envelope.nextBefore ?? null };
    }

    private async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
        let lastErr: PrizerailApiError | null = null;
        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
            const outcome = await this.attempt(method, path, body);
            if (outcome.ok) return outcome.json;
            lastErr = outcome.error;
            if (!lastErr.retryable || attempt === this.maxAttempts) break;
            const backoff = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** (attempt - 1));
            await this.sleep(outcome.retryAfterMs ?? backoff);
        }
        throw lastErr ?? new PrizerailApiError('prizerail: no attempts made', 0, 'no_attempt', false);
    }

    private async attempt(method: 'GET' | 'POST', path: string, body?: unknown): Promise<AttemptResult> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method,
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                    Accept: 'application/json',
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
            if (!res.ok) {
                return { ok: false, error: await errorFromResponse(res), retryAfterMs: retryAfterMs(res) };
            }
            return { ok: true, json: await successBody(res) };
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                ok: false,
                error: new PrizerailApiError(`prizerail transport error: ${msg}`, 0, 'transport', true),
                retryAfterMs: null,
            };
        } finally {
            clearTimeout(timer);
        }
    }
}

function issues(error: z.ZodError): string {
    return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

function parseOrThrow<T>(schema: z.ZodType<T>, json: unknown, what: string): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
        throw new PrizerailApiError(
            `prizerail: unexpected ${what} response shape: ${issues(parsed.error)}`,
            0,
            'bad_response',
            false,
        );
    }
    return parsed.data;
}
