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

CREATE INDEX IF NOT EXISTS prizerail_winners_payable
    ON prizerail_winners (campaign, draw_at)
    WHERE payout_status = 'pending';

CREATE TABLE IF NOT EXISTS prizerail_drawings_done (
    campaign    TEXT        NOT NULL,
    drawing_id  TEXT        NOT NULL,
    done_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (campaign, drawing_id)
);
`;
