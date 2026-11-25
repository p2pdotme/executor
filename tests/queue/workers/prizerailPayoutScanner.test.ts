import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PrizerailStore } from '../../../src/prizerail/store';
import type { PrizerailDrawing, PrizerailDrawingsPage, PrizerailPayout, PrizerailWinner } from '../../../src/prizerail/types';
import { runScanTick, ScanCtx } from '../../../src/queue/workers/prizerailPayoutScannerWorker';
import { payWinner, PayoutDeps } from '../../../src/queue/workers/prizerailPayoutWorker';
import type { PrizerailPayoutJobData } from '../../../src/queue/types';

// End to end over a real Postgres: fake Prizerail → scanner tick → ledger →
// queued jobs → the real payout worker logic against a fake chain. Skipped
// without PRIZERAIL_TEST_DATABASE_URL (see store.test.ts).
const url = process.env.PRIZERAIL_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const SLUG = `scan-${Date.now()}`;
const WALLET_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const WALLET_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const PRIZE = '0xcccccccccccccccccccccccccccccccccccccccc';
const SHARE_URL = 'https://prizerail.test/share/abc';
const NO_SHARE = { required: false, status: null, url: null };

const winner = (over: Partial<PrizerailWinner>): PrizerailWinner => ({
    position: 0,
    winner: 'ent-a',
    amountCents: 1500,
    heldForManualPayout: false,
    publicity: NO_SHARE,
    ...over,
});
const lump = (status: string, amountCents = 1500): PrizerailPayout => ({
    id: 'lump', kind: 'lump_sum', amountCents, status, txHash: status === 'confirmed' ? '0xlump' : null, winnerPosition: null,
});
const own = (status: string, position = 0): PrizerailPayout => ({
    id: 'own', kind: 'publicity_prize', amountCents: 100_000, status, txHash: status === 'confirmed' ? '0xprize' : null, winnerPosition: position,
});
const drawing = (over: Partial<PrizerailDrawing>): PrizerailDrawing => ({
    id: 'd1', number: 1, kind: 'regular', drawAt: '2026-11-25T16:15:00Z', status: 'settled', winners: [], payouts: [], ...over,
});

run('scanner tick → ledger → payout worker', () => {
    let store: PrizerailStore;
    let drawings: PrizerailDrawing[];
    let alerts: string[];
    let fails: string[];
    let queued: PrizerailPayoutJobData[];
    let sent: Array<{ to: string; amount: bigint }>;
    let discordUp: boolean;
    let ctx: ScanCtx;
    let payDeps: PayoutDeps;

    beforeAll(async () => {
        store = new PrizerailStore(url!);
        await store.applySchema();
    });
    afterAll(async () => {
        await store.deleteCampaign(SLUG);
        await store.close();
    });

    beforeEach(async () => {
        await store.deleteCampaign(SLUG);
        await store.rememberEntrant(SLUG, 'ent-a', WALLET_A);
        await store.rememberEntrant(SLUG, 'ent-b', WALLET_B);
        drawings = [];
        alerts = [];
        fails = [];
        queued = [];
        sent = [];
        discordUp = true;
        ctx = {
            prizerail: { campaignSlug: SLUG, payoutEnabled: true },
            store,
            client: {
                listDrawings: async ({ status } = {}): Promise<PrizerailDrawingsPage> => ({
                    drawings: drawings.filter((d) => d.status === status),
                    invalid: 0,
                    nextBefore: null,
                }),
            },
            alertSuccess: async (m) => {
                if (discordUp) alerts.push(m);
                return discordUp;
            },
            alertFail: async (m) => {
                fails.push(m);
            },
            enqueuePayout: async (job) => {
                queued.push(job);
            },
        };
        payDeps = {
            dryRun: false,
            campaign: SLUG,
            prizeAddress: PRIZE,
            minBalance: 0n,
            store,
            balanceOf: async () => 10_000_000_000n,
            minedNonce: async () => 1,
            receiptStatus: async () => 1,
            transfer: async (to, amount, onSent) => {
                sent.push({ to, amount });
                await onSent(`0xpay${sent.length}`);
                return true;
            },
            alertSuccess: async (m) => {
                alerts.push(m);
            },
            alertFail: async (m) => {
                fails.push(m);
            },
            alertBalance: async () => {},
            now: () => Date.now(),
            balanceAlert: { lastAt: 0 },
        };
    });

    /** One scan tick, then the payout worker drains whatever was queued. */
    async function tick(): Promise<PrizerailPayoutJobData[]> {
        queued = [];
        await runScanTick(ctx);
        const jobs = [...queued];
        for (const job of jobs) await payWinner(payDeps, job);
        return jobs;
    }
    const status = async (position = 0, drawingId = 'd1') => (await store.getWinner(SLUG, drawingId, position))?.payoutStatus;

    test('previous flow: a small prize in a paid drawing is alerted once, paid once, and the drawing closed', async () => {
        drawings = [drawing({ status: 'paid', winners: [winner({})], payouts: [lump('confirmed')] })];
        await tick();
        expect(sent).toEqual([{ to: WALLET_A, amount: 15_000_000n }]);
        expect(await status()).toBe('paid');
        expect(await store.isDrawingDone(SLUG, 'd1')).toBe(true);
        expect(alerts.filter((a) => a.includes('winner(s)'))).toHaveLength(1);
        expect(alerts.some((a) => a.includes('released by Prizerail'))).toBe(false);

        await tick();
        await tick();
        expect(sent).toHaveLength(1);
        expect(alerts.filter((a) => a.includes('winner(s)'))).toHaveLength(1);
    });

    test('previous flow: a settled drawing whose lump sum is confirmed pays without waiting for paid', async () => {
        drawings = [drawing({ winners: [winner({})], payouts: [lump('confirmed')] })];
        await tick();
        expect(sent).toHaveLength(1);
        expect(await store.isDrawingDone(SLUG, 'd1')).toBe(false); // still settled
        drawings = [drawing({ status: 'paid', winners: [winner({})], payouts: [lump('confirmed')] })];
        await tick();
        expect(sent).toHaveLength(1);
        expect(await store.isDrawingDone(SLUG, 'd1')).toBe(true);
    });

    test('previous flow: an over-cap prize is held until approved, an unresolved entrant is alerted', async () => {
        const big = winner({ amountCents: 20_000 }); // $200: over the $100 cap, under any Prizerail hold
        const ghost = winner({ position: 1, winner: 'ent-ghost' });
        drawings = [drawing({ status: 'paid', winners: [big, ghost], payouts: [lump('confirmed', 21_500)] })];
        await tick();
        expect(sent).toEqual([]);
        expect(await status(0)).toBe('held');
        expect(await status(1)).toBe('unresolved_entrant');
        expect(fails.some((f) => f.includes('no wallet in the entrant map'))).toBe(true);

        expect(await store.approveHeld(SLUG, 'd1', 0, 'ok')).toBe(true);
        await tick(); // drawing is done; the catch-all re-queue picks the approved row up
        expect(sent).toEqual([{ to: WALLET_A, amount: 200_000_000n }]);
        expect(await status(0)).toBe('paid');
    });

    test('a prize waits while the lump sum is not confirmed, then pays', async () => {
        drawings = [drawing({ winners: [winner({})], payouts: [lump('submitted')] })];
        await tick();
        expect(sent).toEqual([]);
        expect((await store.getWinner(SLUG, 'd1', 0))?.releaseBlocked).toBe('awaiting Prizerail lump_sum transfer (submitted)');

        drawings = [drawing({ winners: [winner({})], payouts: [lump('confirmed')] })];
        await tick();
        expect(sent).toHaveLength(1);
        expect(alerts.some((a) => a.includes('released by Prizerail') && a.includes('Paying it now'))).toBe(true);
    });

    test('the $1,000 guaranteed prize: share → own transfer → approve → paid exactly once', async () => {
        const small = winner({ position: 1, winner: 'ent-b' });
        const grand = (publicity: PrizerailWinner['publicity']) => winner({ amountCents: 100_000, heldForManualPayout: true, publicity });
        const awaiting = { required: true, status: 'awaiting', url: SHARE_URL };
        const approved = { required: true, status: 'approved', url: null };
        const guarantee = (w: PrizerailWinner, payouts: PrizerailPayout[], st = 'settled') =>
            drawing({ kind: 'guarantee', status: st, winners: [w, small], payouts });

        // 1. Settled: the lump sum covers only the small prize.
        drawings = [guarantee(grand(awaiting), [lump('confirmed'), own('held_publicity')])];
        await tick();
        expect(sent).toEqual([{ to: WALLET_B, amount: 15_000_000n }]); // small prize pays, the $1,000 does not
        let row = await store.getWinner(SLUG, 'd1', 0);
        expect(row).toMatchObject({ payoutStatus: 'held', publicityUrl: SHARE_URL, publicityStatus: 'awaiting' });
        expect(row?.releaseBlocked).toMatch(/awaiting winner share/);
        expect(alerts.join('\n')).not.toContain(SHARE_URL);

        // 2. Operator approves early: still nothing leaves.
        expect(await store.approveHeld(SLUG, 'd1', 0, 'approved by ops')).toBe(true);
        await tick();
        await tick();
        expect(sent).toHaveLength(1);
        expect(await status(0)).toBe('pending');

        // 3. Winner shared, Prizerail approved it, transfer not confirmed yet.
        drawings = [guarantee(grand(approved), [lump('confirmed'), own('submitted')])];
        await tick();
        expect(sent).toHaveLength(1);
        expect((await store.getWinner(SLUG, 'd1', 0))?.releaseBlocked).toBe('awaiting Prizerail publicity_prize transfer (submitted)');

        // 4. Its own transfer confirms: paid on this tick, one release alert.
        drawings = [guarantee(grand(approved), [lump('confirmed'), own('confirmed')])];
        await tick();
        expect(sent).toHaveLength(2);
        expect(sent[1]).toEqual({ to: WALLET_A, amount: 1_000_000_000n });
        row = await store.getWinner(SLUG, 'd1', 0);
        expect(row).toMatchObject({ payoutStatus: 'paid', fundingKind: 'publicity_prize', fundingTxHash: '0xprize' });

        // 5. Drawing flips to paid: closed, nothing sent or alerted again.
        drawings = [guarantee(grand(approved), [lump('confirmed'), own('confirmed')], 'paid')];
        await tick();
        await tick();
        expect(sent).toHaveLength(2);
        expect(await store.isDrawingDone(SLUG, 'd1')).toBe(true);
        expect(alerts.filter((a) => a.includes('released by Prizerail'))).toHaveLength(1);
    });

    test('not approved by an operator: release only alerts with the approve command, nothing is sent', async () => {
        const grand = winner({ amountCents: 100_000, heldForManualPayout: true, publicity: { required: true, status: 'awaiting', url: SHARE_URL } });
        drawings = [drawing({ winners: [grand], payouts: [own('held_publicity')] })];
        await tick();
        drawings = [drawing({ winners: [{ ...grand, publicity: { required: true, status: 'approved', url: null } }], payouts: [own('confirmed')] })];
        await tick();
        expect(sent).toEqual([]);
        expect(await status()).toBe('held');
        expect(alerts.some((a) => a.includes('prizerail:payout approve d1 0'))).toBe(true);
    });

    test('a paid drawing with a prize still blocked stays open and is paid when it clears', async () => {
        const held = winner({ amountCents: 5_000, heldForManualPayout: true });
        drawings = [drawing({ status: 'paid', winners: [held], payouts: [lump('confirmed')] })]; // no row of its own
        await tick();
        expect(sent).toEqual([]);
        expect(await store.isDrawingDone(SLUG, 'd1')).toBe(false);

        drawings = [drawing({ status: 'paid', winners: [held], payouts: [lump('confirmed'), { ...own('confirmed'), kind: 'large_prize', amountCents: 5_000 }] })];
        await tick();
        expect(sent).toEqual([{ to: WALLET_A, amount: 50_000_000n }]);
        await tick();
        expect(await store.isDrawingDone(SLUG, 'd1')).toBe(true);
    });

    test('a release alert Discord refused is re-sent on the next tick, and the drawing stays open until then', async () => {
        drawings = [drawing({ winners: [winner({})], payouts: [lump('pending')] })];
        await tick();
        discordUp = false;
        drawings = [drawing({ status: 'paid', winners: [winner({})], payouts: [lump('confirmed')] })];
        await tick();
        expect(sent).toHaveLength(1); // money still moves
        expect(await store.isDrawingDone(SLUG, 'd1')).toBe(false);
        discordUp = true;
        await tick();
        expect(alerts.filter((a) => a.includes('released by Prizerail'))).toHaveLength(1);
        expect(await store.isDrawingDone(SLUG, 'd1')).toBe(true);
        expect(sent).toHaveLength(1);
    });

    test('payout switched off: winners are ledgered and alerted, nothing is queued', async () => {
        ctx = { ...ctx, prizerail: { campaignSlug: SLUG, payoutEnabled: false } };
        drawings = [drawing({ status: 'paid', winners: [winner({})], payouts: [lump('confirmed')] })];
        expect(await tick()).toEqual([]);
        expect(await status()).toBe('pending');
        expect(alerts).toHaveLength(1);
    });
});
