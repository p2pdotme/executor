import { Pool } from 'pg';
import { PRIZERAIL_SCHEMA_SQL } from './schema';
import type { PayoutDecision, PayoutStatus } from './payout';
import type { WinnerRecord } from './winners';

// Postgres-backed ledger for the Prizerail programme: the entrant map
// (pseudonymous id → wallet) and one row per winner carrying its payout
// state. Redis stays queue-only; this is the record of money owed, so it
// lives somewhere durable.

export type WinnerRow = {
    campaign: string;
    drawingId: string;
    position: number;
    drawingNumber: number | null;
    drawingStatus: string;
    drawAt: string;
    entrantId: string;
    wallet: string | null;
    amountCents: number;
    heldForManualPayout: boolean;
    payoutStatus: PayoutStatus;
    holdReason: string | null;
    alerted: boolean;
    txHash: string | null;
    paidAt: string | null;
    attempts: number;
    lastError: string | null;
    // Mined nonce of the prize wallet at claim time (see payout worker).
    sendNonce: number | null;
    recordedAt: number;
    updatedAt: number;
};

export type UpsertResult = {
    inserted: boolean;
    alerted: boolean;
    payoutStatus: PayoutStatus;
};

type RawRow = Record<string, unknown>;

function toRow(r: RawRow): WinnerRow {
    return {
        campaign: String(r.campaign),
        drawingId: String(r.drawing_id),
        position: Number(r.position),
        drawingNumber: r.drawing_number === null ? null : Number(r.drawing_number),
        drawingStatus: String(r.drawing_status),
        drawAt: new Date(r.draw_at as string).toISOString(),
        entrantId: String(r.entrant_id),
        wallet: r.wallet === null ? null : String(r.wallet),
        amountCents: Number(r.amount_cents),
        heldForManualPayout: Boolean(r.held_for_manual_payout),
        payoutStatus: String(r.payout_status) as PayoutStatus,
        holdReason: r.hold_reason === null ? null : String(r.hold_reason),
        alerted: Boolean(r.alerted),
        txHash: r.tx_hash === null ? null : String(r.tx_hash),
        paidAt: r.paid_at === null ? null : new Date(r.paid_at as string).toISOString(),
        attempts: Number(r.attempts),
        lastError: r.last_error === null ? null : String(r.last_error),
        sendNonce: r.send_nonce === null || r.send_nonce === undefined ? null : Number(r.send_nonce),
        recordedAt: Number(r.recorded_at_ms),
        updatedAt: Number(r.updated_at_ms),
    };
}

const ROW_COLUMNS = `*, (EXTRACT(EPOCH FROM recorded_at) * 1000)::bigint AS recorded_at_ms,
       (EXTRACT(EPOCH FROM updated_at) * 1000)::bigint AS updated_at_ms`;
const SELECT_ROW = `SELECT ${ROW_COLUMNS} FROM prizerail_winners`;

export class PrizerailStore {
    private readonly pool: Pool;

    constructor(databaseUrl: string) {
        this.pool = new Pool({
            connectionString: databaseUrl,
            max: 5,
            connectionTimeoutMillis: 10_000,
            idleTimeoutMillis: 30_000,
            statement_timeout: 15_000,
        });
        // An idle-client error with no listener would crash the process.
        this.pool.on('error', (err) => {
            console.error(`[prizerail-store] idle client error: ${err?.message ?? err}`);
        });
    }

    async applySchema(): Promise<void> {
        await this.pool.query(PRIZERAIL_SCHEMA_SQL);
    }

    async close(): Promise<void> {
        await this.pool.end();
    }

    // ── entrant map ─────────────────────────────────────────────────────

    async rememberEntrant(campaign: string, entrantId: string, wallet: string): Promise<void> {
        await this.pool.query(
            `INSERT INTO prizerail_entrants (campaign, entrant_id, wallet)
             VALUES ($1, $2, $3)
             ON CONFLICT (campaign, entrant_id) DO NOTHING`,
            [campaign, entrantId, wallet.toLowerCase()],
        );
    }

    async resolveEntrants(campaign: string, entrantIds: readonly string[]): Promise<Record<string, string | null>> {
        if (entrantIds.length === 0) return {};
        const res = await this.pool.query<{ entrant_id: string; wallet: string }>(
            `SELECT entrant_id, wallet FROM prizerail_entrants
             WHERE campaign = $1 AND entrant_id = ANY($2::text[])`,
            [campaign, [...entrantIds]],
        );
        const found = new Map(res.rows.map((r) => [r.entrant_id, r.wallet]));
        return Object.fromEntries(entrantIds.map((id) => [id, found.get(id) ?? null]));
    }

    // ── winners ─────────────────────────────────────────────────────────

    /**
     * Insert a winner once; on later sightings refresh the drawing status,
     * fill a wallet that was unresolved before, and — while nothing has
     * been sent — take the amount Prizerail now reports, so a late-resolved
     * or approved row is paid what Prizerail says, not what it said first.
     * Terminal payout states (paying/paid/manual/failed) are never reopened
     * or re-priced by a re-scan.
     */
    async upsertWinner(campaign: string, r: WinnerRecord, decision: PayoutDecision): Promise<UpsertResult> {
        const res = await this.pool.query<RawRow>(
            `INSERT INTO prizerail_winners (
                campaign, drawing_id, position, drawing_number, drawing_kind, drawing_status,
                draw_at, entrant_id, wallet, amount_cents, held_for_manual_payout,
                payout_status, hold_reason, recorded_at
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, to_timestamp($14 / 1000.0))
             ON CONFLICT (campaign, drawing_id, position) DO UPDATE SET
                drawing_status = EXCLUDED.drawing_status,
                wallet = COALESCE(prizerail_winners.wallet, EXCLUDED.wallet),
                held_for_manual_payout = prizerail_winners.held_for_manual_payout OR EXCLUDED.held_for_manual_payout,
                amount_cents = CASE
                    WHEN prizerail_winners.payout_status IN ('pending', 'held', 'unresolved_entrant')
                        THEN EXCLUDED.amount_cents
                    ELSE prizerail_winners.amount_cents END,
                payout_status = CASE
                    -- a wallet turned up for a previously unresolved entrant
                    WHEN prizerail_winners.payout_status = 'unresolved_entrant' AND EXCLUDED.wallet IS NOT NULL
                        THEN EXCLUDED.payout_status
                    -- Prizerail put a hold on it, or the amount changed, before we paid
                    WHEN prizerail_winners.payout_status = 'pending'
                         AND (EXCLUDED.held_for_manual_payout OR EXCLUDED.amount_cents <> prizerail_winners.amount_cents)
                        THEN 'held'
                    ELSE prizerail_winners.payout_status END,
                hold_reason = CASE
                    WHEN prizerail_winners.payout_status = 'unresolved_entrant' AND EXCLUDED.wallet IS NOT NULL
                        THEN EXCLUDED.hold_reason
                    WHEN prizerail_winners.payout_status = 'pending' AND EXCLUDED.held_for_manual_payout
                        THEN 'held by Prizerail for review (seen after first sighting)'
                    WHEN prizerail_winners.payout_status = 'pending' AND EXCLUDED.amount_cents <> prizerail_winners.amount_cents
                        THEN 'amount changed after first sighting: ' || prizerail_winners.amount_cents || 'c → ' || EXCLUDED.amount_cents || 'c'
                    WHEN prizerail_winners.payout_status = 'held' AND EXCLUDED.amount_cents <> prizerail_winners.amount_cents
                        THEN COALESCE(prizerail_winners.hold_reason || '; ', '') || 'amount changed while held: '
                             || prizerail_winners.amount_cents || 'c → ' || EXCLUDED.amount_cents || 'c'
                    ELSE prizerail_winners.hold_reason END,
                updated_at = now()
             -- xmax = 0 is true only for a freshly inserted row (no prior version);
             -- an ON CONFLICT update leaves the old tuple's xmax set.
             RETURNING (xmax = 0) AS inserted, alerted, payout_status`,
            [
                campaign, r.drawingId, r.position, r.drawingNumber, r.drawingKind, r.drawingStatus,
                r.drawAt, r.entrantId, r.wallet?.toLowerCase() ?? null, r.amountCents, r.heldForManualPayout,
                decision.status, decision.reason, r.recordedAt,
            ],
        );
        const row = res.rows[0];
        return {
            inserted: Boolean(row.inserted),
            alerted: Boolean(row.alerted),
            payoutStatus: String(row.payout_status) as PayoutStatus,
        };
    }

    async getWinner(campaign: string, drawingId: string, position: number): Promise<WinnerRow | null> {
        const res = await this.pool.query<RawRow>(
            `${SELECT_ROW} WHERE campaign = $1 AND drawing_id = $2 AND position = $3`,
            [campaign, drawingId, position],
        );
        return res.rows[0] ? toRow(res.rows[0]) : null;
    }

    async markAlerted(campaign: string, records: readonly { drawingId: string; position: number }[]): Promise<void> {
        for (const r of records) {
            await this.pool.query(
                `UPDATE prizerail_winners SET alerted = true, updated_at = now()
                 WHERE campaign = $1 AND drawing_id = $2 AND position = $3`,
                [campaign, r.drawingId, r.position],
            );
        }
    }

    async listPayable(campaign: string, limit: number): Promise<WinnerRow[]> {
        const res = await this.pool.query<RawRow>(
            `${SELECT_ROW}
             WHERE campaign = $1 AND payout_status = 'pending' AND wallet IS NOT NULL
             ORDER BY draw_at ASC, position ASC
             LIMIT $2`,
            [campaign, limit],
        );
        return res.rows.map(toRow);
    }

    // ── payout state machine ────────────────────────────────────────────

    /** pending → paying, only if still pending. Null means someone else has it. */
    async claimPayout(campaign: string, drawingId: string, position: number): Promise<WinnerRow | null> {
        const res = await this.pool.query<RawRow>(
            `WITH claimed AS (
                UPDATE prizerail_winners
                SET payout_status = 'paying', attempts = attempts + 1, updated_at = now(), send_nonce = NULL, tx_hash = NULL
                WHERE campaign = $1 AND drawing_id = $2 AND position = $3
                  AND payout_status = 'pending' AND wallet IS NOT NULL
                RETURNING *
             )
             SELECT ${ROW_COLUMNS} FROM claimed`,
            [campaign, drawingId, position],
        );
        return res.rows[0] ? toRow(res.rows[0]) : null;
    }

    /** Rows claimed longer ago than `olderThanMs` that are still 'paying'. */
    async listStalePaying(campaign: string, olderThanMs: number, limit: number): Promise<WinnerRow[]> {
        const res = await this.pool.query<RawRow>(
            `${SELECT_ROW}
             WHERE campaign = $1 AND payout_status = 'paying'
               AND updated_at < now() - ($2::bigint * interval '1 millisecond')
             ORDER BY updated_at ASC
             LIMIT $3`,
            [campaign, olderThanMs, limit],
        );
        return res.rows.map(toRow);
    }

    async recordSendNonce(campaign: string, drawingId: string, position: number, nonce: number): Promise<void> {
        await this.pool.query(
            `UPDATE prizerail_winners SET send_nonce = $4
             WHERE campaign = $1 AND drawing_id = $2 AND position = $3 AND payout_status = 'paying'`,
            [campaign, drawingId, position, nonce],
        );
    }

    /** paying → pending, for a transient problem (no funds yet, RPC down). */
    async releaseClaim(campaign: string, drawingId: string, position: number, reason: string): Promise<void> {
        await this.setStatus(campaign, drawingId, position, 'paying', 'pending', { last_error: reason, send_nonce: null, tx_hash: null });
    }

    async recordTxHash(campaign: string, drawingId: string, position: number, txHash: string): Promise<void> {
        await this.pool.query(
            `UPDATE prizerail_winners SET tx_hash = $4, updated_at = now()
             WHERE campaign = $1 AND drawing_id = $2 AND position = $3 AND payout_status = 'paying'`,
            [campaign, drawingId, position, txHash],
        );
    }

    async markPaid(campaign: string, drawingId: string, position: number, txHash: string): Promise<void> {
        await this.setStatus(campaign, drawingId, position, 'paying', 'paid', {
            tx_hash: txHash,
            paid_at: new Date().toISOString(),
            last_error: null,
        });
    }

    /** Sent (or possibly sent) but not confirmed: a human checks the chain. */
    async markManual(campaign: string, drawingId: string, position: number, reason: string): Promise<void> {
        await this.setStatus(campaign, drawingId, position, 'paying', 'manual', { last_error: reason });
    }

    /** Never sent (presim or send failed). Not retried automatically. */
    async markFailed(campaign: string, drawingId: string, position: number, reason: string): Promise<void> {
        await this.setStatus(campaign, drawingId, position, 'paying', 'failed', { last_error: reason });
    }

    // ── operator moves (scripts/prizerail-payout) ───────────────────────
    // Each returns false when the row is no longer in the expected status.

    /** Rows a human has to act on, oldest first. */
    async listNeedsAttention(campaign: string, limit: number): Promise<WinnerRow[]> {
        const res = await this.pool.query<RawRow>(
            `${SELECT_ROW}
             WHERE campaign = $1 AND payout_status IN ('held', 'manual', 'failed', 'unresolved_entrant')
             ORDER BY draw_at ASC, position ASC
             LIMIT $2`,
            [campaign, limit],
        );
        return res.rows.map(toRow);
    }

    /** Other rows already recorded as paid by this transfer. */
    async findPaidByTxHash(campaign: string, txHash: string): Promise<WinnerRow[]> {
        const res = await this.pool.query<RawRow>(
            `${SELECT_ROW} WHERE campaign = $1 AND lower(tx_hash) = lower($2) AND payout_status = 'paid'`,
            [campaign, txHash],
        );
        return res.rows.map(toRow);
    }

    /** held → pending: the payout worker pays it on the next scan. */
    async approveHeld(campaign: string, drawingId: string, position: number, note: string): Promise<boolean> {
        return this.setStatus(campaign, drawingId, position, 'held', 'pending', { last_error: note });
    }

    /** failed → pending. Only for rows that were never broadcast. */
    async retryFailed(campaign: string, drawingId: string, position: number, note: string): Promise<boolean> {
        return this.setStatus(campaign, drawingId, position, 'failed', 'pending', {
            last_error: note,
            send_nonce: null,
            tx_hash: null,
        });
    }

    /** held | manual | failed → paid, for a transfer verified on-chain. */
    async markPaidByHand(
        campaign: string,
        drawingId: string,
        position: number,
        from: PayoutStatus,
        txHash: string,
        note: string,
    ): Promise<boolean> {
        return this.setStatus(campaign, drawingId, position, from, 'paid', {
            tx_hash: txHash,
            paid_at: new Date().toISOString(),
            last_error: note,
        });
    }

    private async setStatus(
        campaign: string,
        drawingId: string,
        position: number,
        from: PayoutStatus,
        to: PayoutStatus,
        extra: Record<string, string | number | null>,
    ): Promise<boolean> {
        const params: unknown[] = [campaign, drawingId, position, to, from];
        const assigns = Object.entries(extra).map(([col, value]) => {
            params.push(value);
            return `${col} = $${params.length}`;
        });
        const res = await this.pool.query(
            `UPDATE prizerail_winners
             SET payout_status = $4, updated_at = now()${assigns.length ? `, ${assigns.join(', ')}` : ''}
             WHERE campaign = $1 AND drawing_id = $2 AND position = $3 AND payout_status = $5`,
            params,
        );
        return res.rowCount === 1;
    }

    // ── drawings ────────────────────────────────────────────────────────

    async isDrawingDone(campaign: string, drawingId: string): Promise<boolean> {
        const res = await this.pool.query(
            `SELECT 1 FROM prizerail_drawings_done WHERE campaign = $1 AND drawing_id = $2`,
            [campaign, drawingId],
        );
        return (res.rowCount ?? 0) > 0;
    }

    async markDrawingDone(campaign: string, drawingId: string): Promise<void> {
        await this.pool.query(
            `INSERT INTO prizerail_drawings_done (campaign, drawing_id) VALUES ($1, $2)
             ON CONFLICT DO NOTHING`,
            [campaign, drawingId],
        );
    }

    /** Test helper: wipe one campaign's rows. */
    async deleteCampaign(campaign: string): Promise<void> {
        await this.pool.query(`DELETE FROM prizerail_winners WHERE campaign = $1`, [campaign]);
        await this.pool.query(`DELETE FROM prizerail_entrants WHERE campaign = $1`, [campaign]);
        await this.pool.query(`DELETE FROM prizerail_drawings_done WHERE campaign = $1`, [campaign]);
    }
}
