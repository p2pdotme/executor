// Idempotent DDL, applied at every boot. Append-only: add columns with
// `ADD COLUMN IF NOT EXISTS`, never rewrite existing ones.
export const PRIZERAIL_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS prizerail_entrants (
    campaign    TEXT        NOT NULL,
    entrant_id  TEXT        NOT NULL,
    wallet      TEXT        NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign, entrant_id)
);

CREATE TABLE IF NOT EXISTS prizerail_winners (
    campaign               TEXT        NOT NULL,
    drawing_id             TEXT        NOT NULL,
    position               INTEGER     NOT NULL,
    drawing_number         INTEGER,
    drawing_kind           TEXT        NOT NULL,
    drawing_status         TEXT        NOT NULL,
    draw_at                TIMESTAMPTZ NOT NULL,
    entrant_id             TEXT        NOT NULL,
    wallet                 TEXT,
    amount_cents           BIGINT      NOT NULL,
    held_for_manual_payout BOOLEAN     NOT NULL DEFAULT false,
    payout_status          TEXT        NOT NULL,
    hold_reason            TEXT,
    alerted                BOOLEAN     NOT NULL DEFAULT false,
    tx_hash                TEXT,
    paid_at                TIMESTAMPTZ,
    attempts               INTEGER     NOT NULL DEFAULT 0,
    last_error             TEXT,
    recorded_at            TIMESTAMPTZ NOT NULL,
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign, drawing_id, position)
);

ALTER TABLE prizerail_winners ADD COLUMN IF NOT EXISTS send_nonce INTEGER;

-- Prizerail's release gate (prizerail/release.ts). release_blocked is the
-- reason a prize must not be paid yet; NULL means released.
-- release_checked_at is set by every scan that evaluated the gate.
ALTER TABLE prizerail_winners ADD COLUMN IF NOT EXISTS publicity_required BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE prizerail_winners ADD COLUMN IF NOT EXISTS publicity_status   TEXT;
ALTER TABLE prizerail_winners ADD COLUMN IF NOT EXISTS publicity_url      TEXT;
ALTER TABLE prizerail_winners ADD COLUMN IF NOT EXISTS funding_kind       TEXT;
ALTER TABLE prizerail_winners ADD COLUMN IF NOT EXISTS funding_status     TEXT;
ALTER TABLE prizerail_winners ADD COLUMN IF NOT EXISTS funding_tx_hash    TEXT;
ALTER TABLE prizerail_winners ADD COLUMN IF NOT EXISTS release_blocked    TEXT;
-- Set when a blocked prize becomes released; cleared once Discord took the alert.
ALTER TABLE prizerail_winners ADD COLUMN IF NOT EXISTS release_alert_due  BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE prizerail_winners ADD COLUMN IF NOT EXISTS release_checked_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS prizerail_winners_payable
    ON prizerail_winners (campaign, draw_at)
    WHERE payout_status = 'pending';

CREATE TABLE IF NOT EXISTS prizerail_drawings_done (
    campaign    TEXT        NOT NULL,
    drawing_id  TEXT        NOT NULL,
    done_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign, drawing_id)
);

-- Unpaid rows written before the release gate existed have never been
-- evaluated. Block them until a scan does: every row of a drawing that is
-- still being scanned (cleared on the next tick), and any row Prizerail was
-- holding (in a finished drawing it stays blocked: pay by hand + mark-paid,
-- as before). Other rows of finished drawings were payable and stay so.
UPDATE prizerail_winners w
SET release_blocked = 'not evaluated yet (row predates the release gate)'
WHERE w.release_checked_at IS NULL
  AND w.release_blocked IS NULL
  AND w.payout_status IN ('pending', 'held', 'unresolved_entrant')
  AND (w.held_for_manual_payout OR NOT EXISTS (
        SELECT 1 FROM prizerail_drawings_done d
        WHERE d.campaign = w.campaign AND d.drawing_id = w.drawing_id));
`;
