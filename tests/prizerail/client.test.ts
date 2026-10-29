import { describe, expect, test } from 'bun:test';
import { PrizerailApiError, PrizerailClient } from '../../src/prizerail/client';

type Call = { url: string; init: RequestInit };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });
}

function makeClient(responses: Array<Response | Error>, calls: Call[] = []) {
    const queue = [...responses];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        calls.push({ url: String(url), init: init ?? {} });
        const next = queue.shift();
        if (!next) throw new Error('no more mocked responses');
        if (next instanceof Error) throw next;
        return next;
    };
    const client = new PrizerailClient({
        baseUrl: 'https://sandbox.prizerail.com/api/v1',
        apiKey: 'pr_sandbox_test',
        campaignSlug: 'p2p-daily',
        fetchImpl,
        sleep: async () => {},
        maxAttempts: 3,
    });
    return { client, calls };
}

const INCREMENT_OK = {
    drawing: { id: 'd1', drawAt: '2026-11-02T17:00:00Z', cutoffAt: '2026-11-02T16:30:00Z' },
    added: 1,
    updated: 0,
    unchanged: 0,
    duplicates: 0,
    entrantCount: 10,
    totalEntries: 400,
};

describe('PrizerailClient.sendIncrementEntries', () => {
    test('posts increment mode with bearer auth to the campaign entries endpoint', async () => {
        const { client, calls } = makeClient([jsonResponse(200, INCREMENT_OK)]);
        const res = await client.sendIncrementEntries([
            { entrantId: 'abc', entries: 250, eventId: 'order-42' },
        ]);

        expect(res.added).toBe(1);
        expect(res.drawing.id).toBe('d1');
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe('https://sandbox.prizerail.com/api/v1/campaigns/p2p-daily/entries');
        expect(calls[0].init.method).toBe('POST');
        const headers = calls[0].init.headers as Record<string, string>;
        expect(headers.Authorization).toBe('Bearer pr_sandbox_test');
        expect(JSON.parse(String(calls[0].init.body))).toEqual({
            mode: 'increment',
            entrants: [{ entrantId: 'abc', entries: 250, eventId: 'order-42' }],
        });
    });

    test('rejects an empty batch without calling the API', async () => {
        const { client, calls } = makeClient([]);
        await expect(client.sendIncrementEntries([])).rejects.toThrow(/empty/);
        expect(calls).toHaveLength(0);
    });

    test('rejects a batch over 1,000 entrants without calling the API', async () => {
        const { client, calls } = makeClient([]);
        const big = Array.from({ length: 1001 }, (_, i) => ({
            entrantId: `e${i}`,
            entries: 1,
            eventId: `ev${i}`,
        }));
        await expect(client.sendIncrementEntries(big)).rejects.toThrow(/1000/);
        expect(calls).toHaveLength(0);
    });

    test('retries on 429 honouring Retry-After, then succeeds', async () => {
        const { client, calls } = makeClient([
            jsonResponse(429, { code: 'rate_limited' }, { 'retry-after': '1' }),
            jsonResponse(200, INCREMENT_OK),
        ]);
        const res = await client.sendIncrementEntries([{ entrantId: 'a', entries: 1, eventId: 'e' }]);
        expect(res.added).toBe(1);
        expect(calls).toHaveLength(2);
    });

    test('retries on 5xx and network errors up to maxAttempts then throws retryable', async () => {
        const { client, calls } = makeClient([
            jsonResponse(503, { code: 'unavailable' }),
            new Error('ECONNRESET'),
            jsonResponse(502, { code: 'bad_gateway' }),
        ]);
        const err = await client
            .sendIncrementEntries([{ entrantId: 'a', entries: 1, eventId: 'e' }])
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PrizerailApiError);
        expect((err as PrizerailApiError).retryable).toBe(true);
        expect(calls).toHaveLength(3);
    });

    test('does not retry a 409 event_conflict and surfaces the code (real body shape)', async () => {
        const { client, calls } = makeClient([
            jsonResponse(409, { error: 'event_conflict', detail: 'eventId reused' }),
        ]);
        const err = await client
            .sendIncrementEntries([{ entrantId: 'a', entries: 1, eventId: 'e' }])
            .catch((e: unknown) => e);
        expect(err).toBeInstanceOf(PrizerailApiError);
        expect((err as PrizerailApiError).status).toBe(409);
        expect((err as PrizerailApiError).code).toBe('event_conflict');
        expect((err as PrizerailApiError).message).toContain('eventId reused');
        expect((err as PrizerailApiError).retryable).toBe(false);
        expect(calls).toHaveLength(1);
    });

    test('still reads a legacy {code,message} error body', async () => {
        const { client } = makeClient([jsonResponse(409, { code: 'campaign_ended', message: 'over' })]);
        await expect(
            client.sendIncrementEntries([{ entrantId: 'a', entries: 1, eventId: 'e' }]),
        ).rejects.toMatchObject({ code: 'campaign_ended' });
    });

    test('does not retry a 400 bad_request', async () => {
        const { client, calls } = makeClient([jsonResponse(400, { code: 'bad_request' })]);
        await expect(
            client.sendIncrementEntries([{ entrantId: 'a', entries: 1, eventId: 'e' }]),
        ).rejects.toMatchObject({ status: 400, retryable: false });
        expect(calls).toHaveLength(1);
    });

    test('treats a 2xx with an unexpected body as success (entry already landed)', async () => {
        const { client } = makeClient([jsonResponse(200, { nope: true })]);
        const res = await client.sendIncrementEntries([{ entrantId: 'a', entries: 1, eventId: 'e' }]);
        expect(res.added).toBe(0);
        expect(res.duplicates).toBe(0);
        expect(res.drawing).toBeNull();
    });

    test('treats a 2xx with a non-JSON body as success', async () => {
        const { client } = makeClient([new Response('ok', { status: 200 })]);
        const res = await client.sendIncrementEntries([{ entrantId: 'a', entries: 1, eventId: 'e' }]);
        expect(res.drawing).toBeNull();
    });

    test('does not retry a 401 at the HTTP level', async () => {
        const { client, calls } = makeClient([jsonResponse(401, { code: 'unauthorized' })]);
        await expect(
            client.sendIncrementEntries([{ entrantId: 'a', entries: 1, eventId: 'e' }]),
        ).rejects.toMatchObject({ status: 401, code: 'unauthorized', retryable: false });
        expect(calls).toHaveLength(1);
    });
});

const DRAWING = {
    id: 'd9',
    number: 12,
    kind: 'regular',
    drawAt: '2026-11-03T17:00:00Z',
    cutoffAt: '2026-11-03T16:30:00Z',
    status: 'paid',
    winnersExpected: 2,
    winners: [
        { position: 1, winner: 'aaa', randomValue: '0x1', roll: 500, amountCents: 1500, heldForManualPayout: false },
        { position: 2, winner: 'bbb', randomValue: '0x2', roll: 7, amountCents: 100000, heldForManualPayout: true },
    ],
    payouts: [{ id: 'p1', kind: 'lump_sum', amountCents: 1500, status: 'confirmed', txHash: '0xabc' }],
};

describe('PrizerailClient drawings', () => {
    test('lists drawings by status with the cursor', async () => {
        const { client, calls } = makeClient([
            jsonResponse(200, { drawings: [DRAWING], nextBefore: null }),
        ]);
        const page = await client.listDrawings({ status: 'paid', limit: 50, before: '2026-11-04T00:00:00Z' });
        expect(page.drawings).toHaveLength(1);
        expect(page.drawings[0].winners[1].heldForManualPayout).toBe(true);
        expect(page.nextBefore).toBeNull();
        const url = new URL(calls[0].url);
        expect(url.pathname).toBe('/api/v1/campaigns/p2p-daily/drawings');
        expect(url.searchParams.get('status')).toBe('paid');
        expect(url.searchParams.get('limit')).toBe('50');
        expect(url.searchParams.get('before')).toBe('2026-11-04T00:00:00Z');
        expect(calls[0].init.method).toBe('GET');
    });

    test('tolerates unknown extra fields and missing optional ones', async () => {
        const sparse = { ...DRAWING, winners: [{ position: 1, winner: 'x', amountCents: 10 }], extra: 1 };
        const { client } = makeClient([jsonResponse(200, { drawings: [sparse], nextBefore: null })]);
        const page = await client.listDrawings({ status: 'paid' });
        expect(page.drawings[0].winners[0].heldForManualPayout).toBe(false);
        expect(page.invalid).toBe(0);
    });

    test('skips a malformed drawing and keeps the rest of the page', async () => {
        const broken = { ...DRAWING, id: 'bad', winners: [{ position: 'one', winner: null }] };
        const { client } = makeClient([
            jsonResponse(200, { drawings: [broken, DRAWING], nextBefore: '2026-11-01T00:00:00Z' }),
        ]);
        const page = await client.listDrawings({ status: 'paid' });
        expect(page.drawings.map((d) => d.id)).toEqual(['d9']);
        expect(page.invalid).toBe(1);
        expect(page.nextBefore).toBe('2026-11-01T00:00:00Z');
    });

    test('rejects a page whose envelope is malformed', async () => {
        const { client } = makeClient([jsonResponse(200, { nope: [] })]);
        await expect(client.listDrawings({ status: 'paid' })).rejects.toMatchObject({ code: 'bad_response' });
    });
});
