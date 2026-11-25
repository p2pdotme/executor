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

// The winner's "share your win" step. While `required` is true Prizerail does
// not release the prize until `status` is 'approved'. `url` is the winner's
// private form (null once approved or closed). Parsed strictly on `required`:
// a shape we cannot read must fail the drawing, never read as "not required".
const publicitySchema = z
    .object({
        required: z.boolean(),
        status: z.string().nullable().optional(),
        url: z.string().nullable().optional(),
    })
    .passthrough();

const winnerSchema = z
    .object({
        position: z.number().int(),
        winner: z.string(),
        amountCents: z.number().int().nonnegative(),
        heldForManualPayout: z.boolean().default(false),
        publicity: publicitySchema.nullable().optional(),
    })
    .passthrough();

// One transfer from Prizerail to the partner payout wallet. `lump_sum` covers
// every prize that is not held (winnerPosition null); a held prize
// (`large_prize`, `publicity_prize`) gets its own row carrying the winner's
// position. `direct` rows pay the winner themselves and never fund us.
const payoutSchema = z
    .object({
        id: z.string().optional(),
        kind: z.string(),
        amountCents: z.number().int().nonnegative().optional(),
        status: z.string(),
        txHash: z.string().nullable().optional(),
        winnerPosition: z.number().int().nullable().optional(),
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
        payouts: z.array(payoutSchema).default([]),
    })
    .passthrough();

export type PrizerailDrawing = z.infer<typeof drawingSchema>;
export type PrizerailWinner = z.infer<typeof winnerSchema>;
export type PrizerailPayout = z.infer<typeof payoutSchema>;

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
