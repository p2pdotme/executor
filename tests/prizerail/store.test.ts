import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PrizerailStore } from '../../src/prizerail/store';
import type { WinnerRecord } from '../../src/prizerail/winners';

// Integration test against a real Postgres. Set PRIZERAIL_TEST_DATABASE_URL
// (e.g. the executor-postgres container) to run; skipped otherwise so the
// unit suite stays green on a laptop without Postgres.
const url = process.env.PRIZERAIL_TEST_DATABASE_URL;
const run = url ? describe : describe.skip;

const SLUG = `test-${Date.now()}`;

const record = (over: Partial<WinnerRecord> = {}): WinnerRecord => ({
    drawingId: 'd1',
    drawingNumber: 1,
    drawingKind: 'regular',
    drawingStatus: 'settled',
    drawAt: '2026-11-03T17:00:00.000Z',
    position: 0,
    entrantId: 'ent-a',
    wallet: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    amountCents: 1500,
    heldForManualPayout: false,
    publicityRequired: false,
    publicityStatus: null,
    publicityUrl: null,
    fundingKind: 'lump_sum',
    fundingStatus: 'confirmed',
    fundingTxHash: '0xfund',
    releaseBlocked: null,
    payoutStatus: 'pending',
    recordedAt: 1_000,
    ...over,
});

run('PrizerailStore', () => {
    let store: PrizerailStore;

    beforeAll(async () => {
        store = new PrizerailStore(url!);
        await store.applySchema();
        // Second apply must be a no-op (boot runs it every time).
        await store.applySchema();
    });

    afterAll(async () => {
        await store.close();
    });

    beforeEach(async () => {
        await store.deleteCampaign(SLUG);
    });

    test('entrant map: remember and resolve, case-insensitive wallet', async () => {
        await store.rememberEntrant(SLUG, 'ent-a', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA');
        await store.rememberEntrant(SLUG, 'ent-a', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'); // idempotent
        const map = await store.resolveEntrants(SLUG, ['ent-a', 'ent-missing']);
        expect(map['ent-a']).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        expect(map['ent-missing']).toBeNull();
        expect(await store.resolveEntrants(SLUG, [])).toEqual({});
    });

    test('upsertWinner inserts once, then only patches status and a late wallet', async () => {
        const first = await store.upsertWinner(SLUG, record({ wallet: null, payoutStatus: 'unresolved_entrant' }), {
            status: 'unresolved_entrant',
            reason: 'no wallet for entrant id',
        });
        expect(first.inserted).toBe(true);
        expect(first.alerted).toBe(false);
        expect(first.payoutStatus).toBe('unresolved_entrant');

        const second = await store.upsertWinner(SLUG, record({ drawingStatus: 'paid' }), { status: 'pending', reason: null });
        expect(second.inserted).toBe(false);
        expect(second.payoutStatus).toBe('pending');

        const row = await store.getWinner(SLUG, 'd1', 0);
        expect(row?.drawingStatus).toBe('paid');
        expect(row?.wallet).toBe(record().wallet);
        expect(row?.recordedAt).toBe(1_000); // original kept
    });

    test('a stored wallet is never cleared and a paid row is never reopened', async () => {
        await store.upsertWinner(SLUG, record(), { status: 'pending', reason: null });
        const claimed = await store.claimPayout(SLUG, 'd1', 0);
        expect(claimed?.payoutStatus).toBe('paying');
        await store.markPaid(SLUG, 'd1', 0, '0xhash');

        const again = await store.upsertWinner(SLUG, record({ wallet: null }), { status: 'unresolved_entrant', reason: 'x' });
        expect(again.payoutStatus).toBe('paid');
        const row = await store.getWinner(SLUG, 'd1', 0);
        expect(row?.wallet).toBe(record().wallet);
        expect(row?.txHash).toBe('0xhash');
    });

    const BLOCKED = {
        heldForManualPayout: true,
        publicityRequired: true,
        publicityStatus: 'awaiting',
        publicityUrl: 'https://prizerail.test/share/abc',
        fundingKind: null,
        fundingStatus: null,
        fundingTxHash: null,
        releaseBlocked: 'awaiting winner share (publicity awaiting)',
    };
    const RELEASED = {
        heldForManualPayout: true,
        publicityRequired: true,
        publicityStatus: 'approved',
        publicityUrl: null,
        fundingKind: 'publicity_prize',
        fundingStatus: 'confirmed',
        fundingTxHash: '0xprize',
        releaseBlocked: null,
    };

    test('a blocked prize is stored with its share link and cannot be listed or claimed', async () => {
        const first = await store.upsertWinner(SLUG, record(BLOCKED), { status: 'pending', reason: null });
        expect(first.releaseBlocked).toMatch(/awaiting winner share/);
        expect(first.releaseAlertDue).toBe(false);
        const row = await store.getWinner(SLUG, 'd1', 0);
        expect(row).toMatchObject({ publicityRequired: true, publicityStatus: 'awaiting', publicityUrl: BLOCKED.publicityUrl, payoutStatus: 'pending' });
        expect(await store.listPayable(SLUG, 10)).toEqual([]);
        expect(await store.claimPayout(SLUG, 'd1', 0)).toBeNull();
        // ...but an operator can see it waiting.
        expect((await store.listNeedsAttention(SLUG, 10)).map((r) => r.position)).toEqual([0]);
    });

    test('release: the gate clears, an alert falls due once, and the row becomes payable', async () => {
        await store.upsertWinner(SLUG, record(BLOCKED), { status: 'pending', reason: null });
        const released = await store.upsertWinner(SLUG, record(RELEASED), { status: 'pending', reason: null });
        expect(released.releaseBlocked).toBeNull();
        expect(released.releaseAlertDue).toBe(true);
        // Still due on the next scan until Discord took it, then never again.
        expect((await store.upsertWinner(SLUG, record(RELEASED), { status: 'pending', reason: null })).releaseAlertDue).toBe(true);
        await store.markReleaseAlerted(SLUG, 'd1', 0);
        expect((await store.upsertWinner(SLUG, record(RELEASED), { status: 'pending', reason: null })).releaseAlertDue).toBe(false);

        const row = await store.getWinner(SLUG, 'd1', 0);
        expect(row).toMatchObject({ fundingKind: 'publicity_prize', fundingStatus: 'confirmed', fundingTxHash: '0xprize', publicityUrl: null });
        expect((await store.listPayable(SLUG, 10)).map((r) => r.position)).toEqual([0]);
        expect((await store.claimPayout(SLUG, 'd1', 0))?.payoutStatus).toBe('paying');
    });

    test('an over-cap prize approved while blocked is paid only after release', async () => {
        const held = { status: 'held' as const, reason: 'amount 100000c above auto-payout cap 10000c' };
        await store.upsertWinner(SLUG, record({ ...BLOCKED, amountCents: 100_000 }), held);
        expect(await store.approveHeld(SLUG, 'd1', 0, 'approved by ops')).toBe(true);
        // A re-scan with Prizerail still holding it keeps the approval and the block.
        const again = await store.upsertWinner(SLUG, record({ ...BLOCKED, amountCents: 100_000 }), held);
        expect(again.payoutStatus).toBe('pending');
        expect(await store.claimPayout(SLUG, 'd1', 0)).toBeNull();

        const released = await store.upsertWinner(SLUG, record({ ...RELEASED, amountCents: 100_000 }), held);
        expect(released).toMatchObject({ payoutStatus: 'pending', releaseBlocked: null, releaseAlertDue: true });
        expect((await store.claimPayout(SLUG, 'd1', 0))?.amountCents).toBe(100_000);
    });

    test('a released prize that Prizerail blocks again drops its pending release alert', async () => {
        await store.upsertWinner(SLUG, record(BLOCKED), { status: 'pending', reason: null });
        expect((await store.upsertWinner(SLUG, record(RELEASED), { status: 'pending', reason: null })).releaseAlertDue).toBe(true);
        expect((await store.upsertWinner(SLUG, record(BLOCKED), { status: 'pending', reason: null })).releaseAlertDue).toBe(false);
    });

    test('rows that predate the gate are blocked at boot until a scan evaluates them', async () => {
        const legacy = `UPDATE prizerail_winners SET release_checked_at = NULL, release_blocked = NULL WHERE campaign = $1`;
        const raw = (store as unknown as { pool: { query: (q: string, p: unknown[]) => Promise<unknown> } }).pool;
        // 0: pending, drawing still scanned · 1: Prizerail-held in a finished drawing · 2: pending in a finished drawing
        await store.upsertWinner(SLUG, record({ position: 0 }), { status: 'pending', reason: null });
        await store.upsertWinner(SLUG, record({ drawingId: 'done', position: 1, heldForManualPayout: true }), { status: 'held', reason: 'held by Prizerail for review' });
        await store.upsertWinner(SLUG, record({ drawingId: 'done', position: 2 }), { status: 'pending', reason: null });
        await store.markDrawingDone(SLUG, 'done');
        await raw.query(legacy, [SLUG]);

        await store.applySchema();
        expect((await store.getWinner(SLUG, 'd1', 0))?.releaseBlocked).toMatch(/predates the release gate/);
        expect((await store.getWinner(SLUG, 'done', 1))?.releaseBlocked).toMatch(/predates the release gate/);
        expect((await store.getWinner(SLUG, 'done', 2))?.releaseBlocked).toBeNull();
        expect(await store.claimPayout(SLUG, 'd1', 0)).toBeNull();

        // The next scan evaluates the open drawing's row and it pays; boot never re-blocks it.
        await store.upsertWinner(SLUG, record({ position: 0 }), { status: 'pending', reason: null });
        await store.applySchema();
        expect((await store.claimPayout(SLUG, 'd1', 0))?.payoutStatus).toBe('paying');
    });

    test('a Prizerail hold seen after first sighting blocks a pending row', async () => {
        await store.upsertWinner(SLUG, record(), { status: 'pending', reason: null });
        await store.upsertWinner(SLUG, record(BLOCKED), { status: 'pending', reason: null });
        const row = await store.getWinner(SLUG, 'd1', 0);
        expect(row?.heldForManualPayout).toBe(true);
        expect(await store.claimPayout(SLUG, 'd1', 0)).toBeNull();
    });

    test('once a transfer is in flight the gate is frozen', async () => {
        await store.upsertWinner(SLUG, record(), { status: 'pending', reason: null });
        await store.claimPayout(SLUG, 'd1', 0);
        const res = await store.upsertWinner(SLUG, record(BLOCKED), { status: 'pending', reason: null });
        expect(res.payoutStatus).toBe('paying');
        expect(res.releaseBlocked).toBeNull();
    });

    test('an amount change seen later parks a pending row', async () => {
        let row;
        await store.upsertWinner(SLUG, record({ position: 1 }), { status: 'pending', reason: null });
        await store.upsertWinner(SLUG, record({ position: 1, amountCents: 2500 }), { status: 'pending', reason: null });
        row = await store.getWinner(SLUG, 'd1', 1);
        expect(row?.payoutStatus).toBe('held');
        expect(row?.holdReason).toMatch(/amount changed after first sighting: 1500c → 2500c/);
        expect(row?.amountCents).toBe(2500); // what Prizerail now says; the old amount is in the reason

        // A held row keeps following Prizerail's amount too, and says so.
        await store.upsertWinner(SLUG, record({ position: 1, amountCents: 3000 }), { status: 'pending', reason: null });
        row = await store.getWinner(SLUG, 'd1', 1);
        expect(row?.payoutStatus).toBe('held');
        expect(row?.amountCents).toBe(3000);
        expect(row?.holdReason).toMatch(/amount changed while held: 2500c → 3000c/);
    });

    test('a late-resolved entrant is paid the amount Prizerail reports now, not the first one', async () => {
        // First sighting: no wallet, $1,000. Later: wallet known, Prizerail says $50.
        await store.upsertWinner(SLUG, record({ wallet: null, amountCents: 100_000 }), { status: 'unresolved_entrant', reason: 'x' });
        await store.upsertWinner(SLUG, record({ amountCents: 5000 }), { status: 'pending', reason: null });
        const row = await store.getWinner(SLUG, 'd1', 0);
        expect(row?.payoutStatus).toBe('pending');
        expect(row?.amountCents).toBe(5000);
    });

    test('the amount is frozen once anything has been sent', async () => {
        await store.upsertWinner(SLUG, record(), { status: 'pending', reason: null });
        await store.claimPayout(SLUG, 'd1', 0);
        await store.upsertWinner(SLUG, record({ amountCents: 9999 }), { status: 'pending', reason: null });
        expect((await store.getWinner(SLUG, 'd1', 0))?.amountCents).toBe(1500);
        await store.markPaid(SLUG, 'd1', 0, '0xhash');
        await store.upsertWinner(SLUG, record({ amountCents: 9999 }), { status: 'pending', reason: null });
        expect((await store.getWinner(SLUG, 'd1', 0))?.amountCents).toBe(1500);
    });

    test('claim snapshots nothing; recordSendNonce/recordTxHash only apply while paying', async () => {
        await store.upsertWinner(SLUG, record(), { status: 'pending', reason: null });
        await store.recordSendNonce(SLUG, 'd1', 0, 42); // not paying yet → ignored
        expect((await store.getWinner(SLUG, 'd1', 0))?.sendNonce).toBeNull();
        await store.claimPayout(SLUG, 'd1', 0);
        await store.recordSendNonce(SLUG, 'd1', 0, 42);
        await store.recordTxHash(SLUG, 'd1', 0, '0xabc');
        const row = await store.getWinner(SLUG, 'd1', 0);
        expect(row?.sendNonce).toBe(42);
        expect(row?.txHash).toBe('0xabc');
        expect(row?.updatedAt).toBeGreaterThan(0);
        await store.releaseClaim(SLUG, 'd1', 0, 'x');
        const released = await store.getWinner(SLUG, 'd1', 0);
        expect(released?.sendNonce).toBeNull();
        expect(released?.txHash).toBeNull();
    });

    test('listStalePaying returns only old paying rows', async () => {
        await store.upsertWinner(SLUG, record(), { status: 'pending', reason: null });
        await store.claimPayout(SLUG, 'd1', 0);
        expect(await store.listStalePaying(SLUG, 60_000, 10)).toHaveLength(0);
        expect((await store.listStalePaying(SLUG, 0, 10)).map((r) => r.position)).toEqual([0]);
    });

    test('markAlerted flips the flag', async () => {
        await store.upsertWinner(SLUG, record(), { status: 'pending', reason: null });
        await store.markAlerted(SLUG, [record()]);
        const second = await store.upsertWinner(SLUG, record(), { status: 'pending', reason: null });
        expect(second.alerted).toBe(true);
    });

    test('claimPayout is at-most-once and releaseClaim reopens it', async () => {
        await store.upsertWinner(SLUG, record(), { status: 'pending', reason: null });
        const a = await store.claimPayout(SLUG, 'd1', 0);
        const b = await store.claimPayout(SLUG, 'd1', 0);
        expect(a?.payoutStatus).toBe('paying');
        expect(b).toBeNull();

        await store.releaseClaim(SLUG, 'd1', 0, 'insufficient balance');
        const row = await store.getWinner(SLUG, 'd1', 0);
        expect(row?.payoutStatus).toBe('pending');
        expect(row?.attempts).toBe(1);
        expect(row?.lastError).toBe('insufficient balance');
    });

    test('recordTxHash, markManual and markFailed keep the hash and reason', async () => {
        await store.upsertWinner(SLUG, record(), { status: 'pending', reason: null });
        await store.claimPayout(SLUG, 'd1', 0);
        await store.recordTxHash(SLUG, 'd1', 0, '0xsent');
        await store.markManual(SLUG, 'd1', 0, 'tx wait timed out');
        let row = await store.getWinner(SLUG, 'd1', 0);
        expect(row?.payoutStatus).toBe('manual');
        expect(row?.txHash).toBe('0xsent');
        expect(row?.lastError).toBe('tx wait timed out');

        await store.upsertWinner(SLUG, record({ position: 1 }), { status: 'pending', reason: null });
        await store.claimPayout(SLUG, 'd1', 1);
        await store.markFailed(SLUG, 'd1', 1, 'presim reverted');
        row = await store.getWinner(SLUG, 'd1', 1);
        expect(row?.payoutStatus).toBe('failed');
    });

    test('listPayable returns only pending rows with a wallet, oldest first', async () => {
        await store.upsertWinner(SLUG, record({ position: 0, drawAt: '2026-11-03T17:00:00.000Z' }), { status: 'pending', reason: null });
        await store.upsertWinner(SLUG, record({ position: 1, drawAt: '2026-11-02T17:00:00.000Z' }), { status: 'pending', reason: null });
        await store.upsertWinner(SLUG, record({ position: 2, amountCents: 100_000 }), { status: 'held', reason: 'above cap' });
        await store.upsertWinner(SLUG, record({ position: 3, wallet: null }), { status: 'unresolved_entrant', reason: 'x' });
        const rows = await store.listPayable(SLUG, 10);
        expect(rows.map((r) => r.position)).toEqual([1, 0]);
    });

    test('drawing done set', async () => {
        expect(await store.isDrawingDone(SLUG, 'd1')).toBe(false);
        await store.markDrawingDone(SLUG, 'd1');
        await store.markDrawingDone(SLUG, 'd1');
        expect(await store.isDrawingDone(SLUG, 'd1')).toBe(true);
    });
    test('operator moves: approve, retry and mark-paid only from the expected status', async () => {
        const held = { status: 'held' as const, reason: 'amount 100000c above auto-payout cap 10000c' };
        await store.upsertWinner(SLUG, record({ amountCents: 100_000, payoutStatus: 'held' }), held);
        expect((await store.listNeedsAttention(SLUG, 10)).map((r) => r.payoutStatus)).toEqual(['held']);

        expect(await store.retryFailed(SLUG, 'd1', 0, 'x')).toBe(false); // not failed
        expect(await store.approveHeld(SLUG, 'd1', 0, 'approved by ops')).toBe(true);
        expect(await store.approveHeld(SLUG, 'd1', 0, 'again')).toBe(false); // already pending
        expect((await store.getWinner(SLUG, 'd1', 0))?.payoutStatus).toBe('pending');
        // A later scan keeps the approved row pending.
        await store.upsertWinner(SLUG, record({ amountCents: 100_000, drawingStatus: 'paid' }), held);
        expect((await store.getWinner(SLUG, 'd1', 0))?.payoutStatus).toBe('pending');

        await store.claimPayout(SLUG, 'd1', 0);
        await store.markFailed(SLUG, 'd1', 0, 'presim rejected');
        expect(await store.retryFailed(SLUG, 'd1', 0, 'retry by ops')).toBe(true);
        await store.claimPayout(SLUG, 'd1', 0);
        await store.markManual(SLUG, 'd1', 0, 'unconfirmed');

        expect(await store.markPaidByHand(SLUG, 'd1', 0, 'held', '0xABC', 'n')).toBe(false); // it is manual
        expect(await store.markPaidByHand(SLUG, 'd1', 0, 'manual', '0xABC', 'paid by hand')).toBe(true);
        const paid = await store.getWinner(SLUG, 'd1', 0);
        expect(paid?.payoutStatus).toBe('paid');
        expect(paid?.txHash).toBe('0xABC');
        expect((await store.findPaidByTxHash(SLUG, '0xabc')).length).toBe(1);
        expect(await store.listNeedsAttention(SLUG, 10)).toEqual([]);
    });
});
