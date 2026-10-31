import { z } from 'zod';

// One increment-mode event. Prizerail stores eventId per campaign and ignores
// repeats, so the order id is the natural key: a WS replay or BullMQ retry
// can never double-count.
export type PrizerailEntryEvent = {
    entrantId: string;
    entries: number;
    eventId: string;
};

const drawingRefSchema = z
    .object({
        id: z.string(),
        drawAt: z.string().optional(),
        cutoffAt: z.string().optional(),
    })
    .passthrough();

// Deliberately lenient: by the time we parse this the POST has succeeded and
// Prizerail holds the entry. Every field here is only logged, so a shape
// change on their side must never turn a success into a "rejected" alert.
export const incrementResponseSchema = z
    .object({
        drawing: drawingRefSchema.nullable().default(null),
        added: z.number().int().nonnegative().default(0),
        updated: z.number().int().nonnegative().default(0),
        unchanged: z.number().int().nonnegative().default(0),
        duplicates: z.number().int().nonnegative().default(0),
        entrantCount: z.number().int().nonnegative().optional(),
        totalEntries: z.number().int().nonnegative().optional(),
    })
    .passthrough();

export type PrizerailIncrementResponse = z.infer<typeof incrementResponseSchema>;

export type PrizerailDrawingStatus =
    | 'open'
    | 'locked'
    | 'entropy_requested'
    | 'settled'
    | 'paid'
    | 'skipped';

const winnerSchema = z
    .object({
        position: z.number().int(),
        winner: z.string(),
        amountCents: z.number().int().nonnegative(),
        heldForManualPayout: z.boolean().default(false),
    })
    .passthrough();

export const drawingSchema = z
    .object({
        id: z.string(),
        number: z.number().int().nullable().optional(),
        kind: z.string().default('regular'),
        drawAt: z.string(),
        cutoffAt: z.string().optional(),
        status: z.string(),
        winnersExpected: z.number().int().nonnegative().optional(),
        winners: z.array(winnerSchema).default([]),
    })
    .passthrough();

export type PrizerailDrawing = z.infer<typeof drawingSchema>;
export type PrizerailWinner = z.infer<typeof winnerSchema>;

// The page envelope is parsed strictly, the drawings inside it one by one,
// so a single odd drawing cannot block winner discovery for the rest.
export const drawingsPageEnvelopeSchema = z
    .object({
        drawings: z.array(z.unknown()),
        nextBefore: z.string().nullable().optional(),
    })
    .passthrough();

export type PrizerailDrawingsPage = {
    drawings: PrizerailDrawing[];
    invalid: number;
    nextBefore: string | null;
};

// Observed shape (sandbox, 2026-10-29): { error: "<code>", detail: "<text>" }.
// `code`/`message` kept as fallbacks in case the shape changes.
export const errorBodySchema = z
    .object({
        error: z.string().optional(),
        detail: z.string().optional(),
        code: z.string().optional(),
        message: z.string().optional(),
    })
    .passthrough();
