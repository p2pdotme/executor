import { describe, expect, test } from 'bun:test';
import { PrizerailApiError } from '../../src/prizerail/client';
import { classifyEntryFailure } from '../../src/prizerail/failures';

const err = (status: number, code: string) => new PrizerailApiError('x', status, code, status === 429 || status >= 500);

describe('classifyEntryFailure', () => {
    test('malformed request, unknown campaign, and eventId conflicts are permanent', () => {
        expect(classifyEntryFailure(err(400, 'bad_request'))).toBe('permanent');
        expect(classifyEntryFailure(err(404, 'not_found'))).toBe('permanent');
        expect(classifyEntryFailure(err(422, 'unprocessable'))).toBe('permanent');
        expect(classifyEntryFailure(err(409, 'event_conflict'))).toBe('permanent');
        expect(classifyEntryFailure(err(409, 'campaign_ended'))).toBe('permanent');
    });

    test('auth, pause, capacity, rate-limit, server and transport errors are transient', () => {
        expect(classifyEntryFailure(err(401, 'unauthorized'))).toBe('transient');
        expect(classifyEntryFailure(err(403, 'forbidden'))).toBe('transient');
        expect(classifyEntryFailure(err(409, 'no_open_drawing'))).toBe('transient');
        expect(classifyEntryFailure(err(409, 'not_taking_entries'))).toBe('transient');
        expect(classifyEntryFailure(err(409, 'too_many_entrants'))).toBe('transient');
        expect(classifyEntryFailure(err(429, 'rate_limited'))).toBe('transient');
        expect(classifyEntryFailure(err(503, 'unavailable'))).toBe('transient');
        expect(classifyEntryFailure(err(0, 'transport'))).toBe('transient');
    });

    test('non-Prizerail errors are transient', () => {
        expect(classifyEntryFailure(new Error('redis down'))).toBe('transient');
        expect(classifyEntryFailure('weird')).toBe('transient');
    });
});
