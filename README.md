# p2pme-executor

## Who can run this?

`p2pme-executor` is a **permissionless keeper**. All contract functions it calls on the Diamond are public (`external`) and do not require any admin role, including:

- `assignMerchants`
- `removeNonEligibleMerchants`
- `removeNonEligibleMerchantsByCircleId`
- `autoCancelExpiredOrders`
- `approveUnstakeBatch`
- `blacklistInactiveMerchants`

This means anyone in the community can run an executor to help operate the protocol. Running an executor does **not** grant any protocol privileges, and multiple operators can run simultaneously without coordination. If another executor has already processed a task, the transaction simply becomes a no-op during simulation.

The only exception is the optional **B2B Cashback** program, which requires an issuer to be whitelisted via `setCreditIssuer`. Community-operated executors can simply leave this feature disabled.

## Funds at risk

The executor never custodys user funds.

It:
- Holds no user funds.
- Holds no merchant stake.
- Has no token approvals.

Its core wallets are used only to pay Base network gas fees.

Operators generate all six wallets themselves (five executor wallets and one funding wallet), fund the `FUNDING_EXECUTOR` wallet with a small amount of ETH, and the executor automatically distributes gas to the remaining wallets as needed. Without Prizerail payouts, the only funds at risk are this gas balance.

**Exception — the optional prize wallet.** When `PRIZE_PAYOUT_EXECUTOR` is set, that wallet **holds USDC**: Prizerail sends each draw's prize USDC to it, and the executor pays winners from it. Those prizes are funds at risk if the key leaks. To limit the exposure:
- Use a dedicated wallet for it, never one of the executor wallets above, and keep only what upcoming payouts need.
- It only sends USDC `transfer`s to winners recorded in the Postgres ledger; it grants no approvals.
- Automatic payouts are capped (`PRIZERAIL_POLICY.maxAutoPayoutCents`): a prize of $20 or more is held for a manual payout.
- Leave `PRIZE_PAYOUT_EXECUTOR` unset to keep every executor wallet gas-only.

## No keys at risk

All private keys are supplied through environment variables.

The executor:
- Reads keys only during startup.
- Never generates keys at runtime.
- Never stores keys in Redis.
- Never writes keys to disk.
- Never logs private keys.
- Fails to start if any required key is missing.

> **Note on the earlier design:** To simplify first-time setup, the executor previously generated keeper wallets automatically and stored their private keys in the operator's own Redis instance. This allowed operators to start the executor without manually creating five keeper wallets, while keeping the generated addresses stable across restarts. Those keys were stored only in the deployment's own Redis instance, accessible only to the operator running it. They were also **gas-only wallets** with **no protocol authority**, holding no user funds or privileged permissions. Even so, storing private keys in any datastore is an unnecessary security risk - this feature now removed.

> Today, all private keys must be supplied through environment variables at startup. Redis now stores only job queues and tracked order IDs, it never stores secrets.

---

## Table of Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Wallet management](#wallet-management)
- [Environment variables](#environment-variables)
- [Dry run mode](#dry-run-mode)
- [Quick start (local)](#quick-start-local)
- [How it works](#how-it-works)
- [Deployment](#deployment)
- [License](#license)

---

## What it does

1. **Event listening** — Subscribes to the Diamond contract on Base (WebSocket). On `OrderPlaced`, immediately enqueues `ToggleMerchantsOffline` and enqueues `AssignMerchants` after a configurable delay. On `OrderCompleted` (when the B2B cashback programme is enabled), enqueues `IssueCashbackCredit` for eligible non-B2B BUY and SELL orders.
2. **Order sweeper** — Every 1 minute: batch-checks all tracked orders via Multicall3, untracking completed/cancelled ones and auto-cancelling expired ones.
3. **Order scanner** — Every 1 hour: rescans the last 2 500 blocks to catch any orders the WS listener may have missed.
4. **B2B cashback programme** — Opt-in via env. Credits a bps cut of every completed non-B2B BUY or SELL back to the order's user (buyer for BUY, seller for SELL) via `cashbackIntegrator.issueCredit(user, amount)`, signed by a dedicated `cashback` wallet that must be whitelisted on the integrator (`setCreditIssuer(cashbackWallet, true)`).
5. **Prizerail draw programme** — Opt-in via env. Same eligibility as the cashback programme (completed non-B2B BUY/SELL), but instead of credit the user earns entries into a [Prizerail](https://docs.prizerail.com/) prize draw: one entry per whole USDC (a $50 order = 50 entries), with INR, VEN and BOB excluded in production, posted over HTTPS (no wallet, no tx). An optional scanner ledgers winners and posts them to Discord. See [Prizerail draw programme](#prizerail-draw-programme).
6. **Auto-funded wallets** — Five subwallets (toggle, assign, sweeper, cashback, keeper) are managed automatically. The funding wallet tops them up whenever any drops below the minimum balance. Discord alerts go to three dedicated channels (success / fail / balance).
7. **Liveness probe** — `GET /healthz` and nothing else. There is no API.

---

## Architecture

```
src/
├── listeners/          # OrderPlaced WS → enqueue toggle + assign jobs; OrderCompleted → cashback / prizerail
├── prizerail/          # Prizerail REST client, entrant HMAC + entry math, winner ledger helpers
├── schedulers/         # Repeating BullMQ jobs (sweeper every 1m, scanner every 1h)
├── queue/
│   ├── index.ts        # Queue definitions + addToggleJob / addAssignJob helpers
│   ├── prizerailQueues.ts # Prizerail entry + payout-scanner queues
│   ├── handlers.ts     # Business logic: toggleMerchantsOffline, assignMerchants
│   └── workers/        # BullMQ workers: toggle, assign, orderSweeper, orderScanner
├── helpers/
│   ├── safeSend.ts     # All contract writes go here (presim → send → wait → alert)
│   ├── walletManager.ts# Subwallet lifecycle: load from env, auto-fund
│   ├── discord.ts      # sendDiscordAlert (3 channel webhooks)
│   ├── multicall.ts    # Multicall3 helper (batch RPC reads into 1 eth_call)
│   ├── config.ts       # loadExecutorConfig() — fails fast on missing env
│   ├── provider.ts     # Alchemy HTTP/WS providers, withTimeout
│   └── abi.ts          # Diamond contract ABI
├── utils/
│   ├── orderTracker.ts # Redis set: track/untrack/sync active order IDs
│   └── fetchPendingOrders.ts  # getLogs → Multicall3 batch status check
└── index.ts            # Bootstrap: config → wallets → workers → listeners → schedulers
```

All contract **writes** go through `safeSend()`. It handles pre-simulation, sending, confirmation wait, nonce resets, and Discord alerts. When `DRY_RUN=true` it only runs `staticCall` — no transaction is ever sent.

---

## Wallet management

The executor uses **five subwallets** (toggle, assign, sweeper, cashback, keeper) plus one **funding wallet**.

### Keys come from the environment, only

Every signing key is read from an env var at boot. The executor never generates a wallet at runtime and never writes a key to Redis, disk, or logs — your platform's secret manager is the single source of truth. A missing key is a hard boot failure.

```env
TOGGLE_EXECUTOR=0x...privatekey
ASSIGN_EXECUTOR=0x...privatekey
ORDER_SWEEPER_EXECUTOR=0x...privatekey
CASHBACK_EXECUTOR=0x...privatekey
KEEPER_EXECUTOR=0x...privatekey
FUNDING_EXECUTOR=0x...privatekey
```

Redis is used for the BullMQ job queues and the tracked-order set only. It holds no secrets.

### To rotate a wallet

Update the env var and redeploy. The new key is used immediately.

### Funding

`FUNDING_EXECUTOR` holds the float. The funding wallet tops up any subwallet that drops below `MIN_BASE_BALANCE_ETH` (default 0.005 ETH), sending enough to bring it to 0.02 ETH. On every boot and every 10 minutes, balances are checked and Discord alerts are sent to the balance channel.

On first boot, Discord (success channel) receives all wallet addresses so you know what to fund.

---

## Environment variables

Copy `.env.example` to `.env` for local dev. In production set these in the platform's secret manager (Railway variables / compose `.env` on the host) — never in a committed file.

### Required

| Variable | Description |
|---|---|
| `ALCHEMY_API_KEY` | Alchemy API key for Base mainnet |
| `DIAMOND_ADDRESS` | Diamond contract address on Base |
| `FUNDING_EXECUTOR` | Private key of the funding wallet (tops up subwallets) |
| `DISCORD_ONSUCCESS_WEBHOOK_URL` | Discord webhook — successful tx alerts |
| `DISCORD_ONFAIL_WEBHOOK_URL` | Discord webhook — failed tx / WS error alerts |
| `DISCORD_BALANCE_WEBHOOK_URL` | Discord webhook — balance + auto-fund alerts |
| `ASSIGN_DELAY_IN_SECONDS` | Seconds to wait before assigning merchants after OrderPlaced (e.g. `90`) |

### Optional

| Variable | Description |
|---|---|
| `REDIS_URL` | Default: `redis://redis:6379`. Use `redis://localhost:6379` for local dev |
| `MIN_BASE_BALANCE_ETH` | Minimum subwallet ETH before auto-fund kicks in (default `0.005`) |
| `LOG_LEVEL` | `debug` / `info` / `warn` / `error` (default `info`) |
| `DRY_RUN` | `true` to simulate only — no transactions sent (default `false`) |
| `PORT` | HTTP port (default `8000`) |
| `CASHBACK_INTEGRATOR_ADDRESS` | B2B cashback programme: integrator address to call `issueCredit` on. Leave unset (or set `CASHBACK_BPS=0`) to disable the programme entirely — the OrderCompleted listener silently no-ops. |
| `CASHBACK_BPS` | B2B cashback programme: bps of each completed non-B2B BUY or SELL amount to credit (e.g. `200` = 2%). Range `[0, 10000]`. `0` disables the programme. |
| `CASHBACK_BPS_BY_CURRENCY` | B2B cashback programme: per-currency overrides as `CODE:bps,...`. Built-in: `ARS` and `MEX` at 100. Not used by Prizerail. |
| `PRIZERAIL_API_KEY` | Prizerail draw programme. Unset = off. The prefix selects the site: `pr_prod_*` → production (campaign `p2p-ramp`, Base mainnet), `pr_sandbox_*` → sandbox (campaign `p2pme-p2pdotme-orders`, Base Sepolia). See `PRIZERAIL_SITES` in `src/prizerail/config.ts`. |
| `PRIZERAIL_ENTRANT_HMAC_KEY` | Required with the key, ≥ 16 chars. Secret for the pseudonymous entrant id. Never rotate on a live campaign. |
| `DATABASE_URL` | Postgres for the Prizerail ledger. Required with the key. |

### Required — subwallet keys

All five are mandatory; the executor refuses to boot if any is missing.

| Variable | Description |
|---|---|
| `TOGGLE_EXECUTOR` | Private key for the toggle wallet |
| `ASSIGN_EXECUTOR` | Private key for the assign wallet |
| `ORDER_SWEEPER_EXECUTOR` | Private key for the sweeper wallet |
| `CASHBACK_EXECUTOR` | Private key for the cashback wallet. Its address must be whitelisted on the cashback integrator via `setCreditIssuer(addr, true)` before `issueCredit` calls land — the startup Discord message prints the address explicitly so you know what to whitelist. |
| `KEEPER_EXECUTOR` | Private key for the daily keeper wallet (`approveUnstakeBatch` + `blacklistInactiveMerchants`) |
| `PRIZE_PAYOUT_EXECUTOR` | *Optional.* Prize wallet for Prizerail payouts; holds and sends USDC. Setting it turns automatic payouts on. USDC is resolved per chain in code. |

---

## Dry run mode

Set `DRY_RUN=true` to run against mainnet without spending gas or changing state.

| Component | Behaviour in dry run |
|---|---|
| `safeSend` (all contract writes) | Runs `staticCall` only — no `sendTransaction` |
| `checkAndFund` (wallet auto-top-up) | Logs `[DRY_RUN] Would auto-fund ...` — no ETH sent |
| Initial `syncOrderIds` (10k block scan) | Skipped entirely |
| WS listener + job queueing | Works normally — jobs execute but hit `safeSend` dry-run path |

Use this to verify your config and contract state before going live. You'll see `safeSend[DRY_RUN]: simulated fn=... ok` or `simulation failed` in logs.

---

## Quick start (local)

```bash
cp .env.example .env
# fill in ALCHEMY_API_KEY, DIAMOND_ADDRESS, FUNDING_EXECUTOR, Discord webhooks, ASSIGN_DELAY_IN_SECONDS

# Option A — Docker (recommended)
./test.sh

# Option B — host Redis + local app
docker run -d -p 6379:6379 redis:7-alpine
REDIS_URL=redis://localhost:6379 npm run dev
```

Health check: `GET http://localhost:8000/healthz`

---

## How it works

### OrderPlaced event flow

```
WebSocket (Alchemy)
  └─ OrderPlaced event
       ├─ trackOrderId in Redis
       ├─ enqueue ToggleMerchantsOffline (immediate)
       │    └─ toggleWorker → getNonEligibleMerchantsByCircleId
       │                    → removeNonEligibleMerchantsByCircleId (if any found)
       │                    (30s cooldown per circleId — atomic Redis SET NX)
       └─ enqueue AssignMerchants (after ASSIGN_DELAY_IN_SECONDS)
            └─ assignWorker → getOrdersById (still PLACED?)
                            → assignMerchants (if still PLACED)
```

### Scheduled jobs

```
Every 1 min — OrderSweeper
  └─ getTrackedOrderIds from Redis
  └─ Multicall3 batch: getOrdersById + isOrderExpired (2N → 1 eth_call)
  └─ untrack completed/cancelled orders
  └─ autoCancelExpiredOrders in batches of 20

Every 1 hour — OrderScanner
  └─ getLogs for OrderPlaced (last 2 500 blocks)
  └─ Multicall3 batch: getOrdersById for all found orders
  └─ union active IDs into Redis tracking set
```

### Prizerail draw programme

Replaces the per-order cashback credit from November 2026. Nothing about *who* is
eligible changes — only *what* they get.

```
OrderCompleted (same filters as cashback: BUY/SELL, non-B2B, rate > 0)
  └─ cashback = amount × bps / 10 000            (per-currency bps via env, default 2%)
  └─ entries  = whole USDC                       (0 for the site's excluded markets: prod INR/VEN/BOB)
  └─ enqueue SendPrizerailEntry  (jobId = prizerail-<orderId>)
       └─ prizerailEntryWorker
            ├─ entrantId = HMAC-SHA256(PRIZERAIL_ENTRANT_HMAC_KEY, wallet)
            ├─ INSERT prizerail_entrants (campaign, entrantId → wallet)   (reverse map for payouts)
            └─ POST /campaigns/<slug>/entries  mode=increment  eventId=order-<orderId>
                 (Prizerail ignores repeated eventIds → retries never double-count)

Every PRIZERAIL_POLICY.payoutScanIntervalMin (5 min) — prizerailPayoutScanner
  └─ GET /campaigns/<slug>/drawings?status=settled|paid
  └─ map each winner's entrantId → wallet via the reverse map
  └─ INSERT prizerail_winners (campaign, drawing, position) ON CONFLICT → patch status / late wallet
  └─ payout enabled? → queue PrizerailPayout for every 'pending' row
  └─ Discord: winners, amounts, held-by-Prizerail flags, unresolved entrants
```

**Payout.** Prizerail pays prize USDC to the campaign's payout wallet, not to
users. Set that payout wallet to the executor's **prize wallet**
(`PRIZE_PAYOUT_EXECUTOR`), and the executor pays each winner from it in the
chain's USDC (`USDC_BY_CHAIN_ID`). The scanner runs whenever the programme is on:

```
scanner → ledger row (payout_status = pending | held | unresolved_entrant)
  └─ enqueue PrizerailPayout (jobId = campaign-drawing-position)
       └─ prizerailPayoutWorker (concurrency 1 — sole writer to the Prize nonce)
            ├─ claimPayout: pending → paying  (at-most-once; a lost race is a no-op)
            ├─ USDC balanceOf(prize) ≥ amount? else release → pending, retry later
            ├─ safeSend usdc.transfer(wallet, amount)   onSent → tx_hash persisted
            ├─ confirmed → paid (+ Discord)   reverted/timeout → manual (verify on-chain)
            └─ retry finds 'paying' + tx_hash → reconcile from the receipt, never re-send
```

Payout statuses: `pending` (will be paid), `held` (needs a human: Prizerail
holds it, it is at/above the $20 cap in `PRIZERAIL_POLICY`, or zero),
`unresolved_entrant` (no wallet in the map), `paying`, `paid`, `manual`
(sent but unconfirmed/reverted), `failed` (never sent). Only `pending` is ever
touched automatically; the rest wait for an operator in `prizerail_winners`.

The $20 cap keeps unattended transfers small; it sits far below Prizerail's
$600 large-prize threshold, past which winners must pass Prizerail's identity
check, which this executor cannot do. The cap, the
scan interval and the prize-wallet balance floor are code constants in
`src/prizerail/config.ts` (`PRIZERAIL_POLICY`) — product rules, changed with
a review, not per deploy.

**Storage.** The entrant map and the winner ledger live in Postgres
(`DATABASE_URL`, schema applied at boot: `prizerail_entrants`,
`prizerail_winners`, `prizerail_drawings_done`). Redis stays queue-only. This
is the record of money owed — back the database up.

**Operational notes.**
- `DRY_RUN=true` skips sending entries only with a `pr_prod_*` key. Sandbox
  entries are always sent — that is what the sandbox is for.
- Only a provably bad request is dropped: 400, 404, 422, or a 409 whose code
  is `event_conflict` / `campaign_ended`. The worker alerts and completes the
  job. Everything else — 401/403 from a rotated key, a paused campaign
  (`no_open_drawing`), 429, 5xx, transport — is retried by BullMQ for about
  20 minutes and then **retained as a failed job** for manual retry, with a
  Discord alert. Retrying is always safe: Prizerail dedupes on `eventId`.
- A 2xx whose body does not match the expected shape is still a success;
  the entry has landed and the body is only logged.
- The entrant map is the only link from a winner back to a wallet. It can be
  rebuilt from order history (wallet → HMAC) as long as the key is unchanged.
- Winner rows are inserted once (`ON CONFLICT`), so overlapping scanner ticks
  or two replicas cannot double-alert or double-pay. The Discord alert is
  only marked sent once the webhook accepts every chunk. A winner whose
  wallet was unresolved is re-resolved on later ticks if the map is repaired.
- Manual payouts: see **Paying held winners** below.
- The HMAC key is part of the campaign's identity. Rotating it makes every
  wallet a new entrant, breaks guarantee-draw de-duplication, and leaves
  existing winners unresolvable. The scanner raises a Discord alert when a
  winner has no wallet in the map.
- Prizerail's eligibility rules (age, excluded US states, OFAC) are not
  enforced here. The order carries only a currency; filtering by residency
  has to happen upstream of `OrderCompleted` or be agreed with Prizerail.

**Paying held winners.** Rows the worker leaves to a human are listed in the
Discord winners alert. Manage them with the operator script, which reads the
executor's env (`PRIZERAIL_API_KEY` picks the site and campaign,
`DATABASE_URL` the ledger, `ALCHEMY_API_KEY` or `RPC_HTTP_URL` the chain):

```
bun run prizerail:payout list                                # local
bun dist/scripts/prizerailPayout.js list                     # in the deployed image
bun run prizerail:payout approve   <drawingId> <position>
bun run prizerail:payout retry     <drawingId> <position>
bun run prizerail:payout mark-paid <drawingId> <position> <txHash>
```

The script never sends USDC. Each command names one row, checks its status
first, and refuses if the row moved on in the meantime. Your OS user name (or
`PRIZERAIL_OPERATOR`) is written to `last_error` as an audit note.

- **`held`, over the $20 cap:** `approve` it. The next scan (within 5 min)
  queues it, and the payout worker sends the full amount from the prize wallet
  with the usual at-most-once checks. The cap is only applied when a winner is
  first recorded, so an approved row is not held again.
- **`held` by Prizerail** (identity check, review; `list` shows it): `approve`
  refuses. Resolve it in the Prizerail portal, then pay by hand.
- **Paid by hand** (any `held`, `manual` or `failed` row): send
  `amount_cents / 100` USDC from the prize wallet to the winner, then
  `mark-paid` with the tx hash. It records the row only if that transaction
  succeeded on the site's chain, contains a USDC transfer of exactly the prize
  to the winner's wallet, and is not already recorded for another winner.
- **`manual`, a transfer may have gone out:** find it (the row's `tx_hash`, or
  the prize wallet's transfers after the claim) and `mark-paid` it. There is
  deliberately no retry for `manual`, because retrying blind can pay twice.
- **`failed`, rejected before broadcast:** fix the cause (usually gas or USDC
  in the prize wallet), then `retry`.
- **`unresolved_entrant`, no wallet for the entrant id:** usually a changed
  `PRIZERAIL_ENTRANT_HMAC_KEY`. Restore the key and the scanner re-resolves the
  row while the drawing is not yet `paid`. Otherwise find the wallet from order
  history and fix the row in SQL.

### All contract writes

```
safeSend()
  ├─ DRY_RUN? → staticCall only, return
  ├─ !skipPresim? → staticCall, return false on revert (with Discord alert)
  ├─ sendTransaction → if NONCE_EXPIRED/REPLACEMENT_UNDERPRICED: NonceManager.reset()
  └─ tx.wait(1) with 3min timeout
       ├─ timeout: check receipt directly, alert, return false
       ├─ reverted: Discord fail alert, return false
       └─ confirmed: Discord success alert, return true
```

---

## Deployment

### VPS (recommended)

See [`deploy/vps/DEPLOY.md`](deploy/vps/DEPLOY.md) for full step-by-step instructions.

```bash
# On the server
mkdir ~/executor && cd ~/executor
nano docker-compose.yml   # paste deploy/vps/docker-compose.yml
nano .env                 # paste deploy/vps/.env.example, fill in all values
docker compose pull && docker compose up -d
docker compose logs -f executor
```

### Build and push image

```bash
# Bump TAG in build_and_push.sh, then:
./build_and_push.sh
# Update the image tag in ~/executor/docker-compose.yml on the server, then:
docker compose pull && docker compose up -d
```

### Networking

The executor exposes no service anyone else consumes — deploy it without a public
domain. The VPS compose file binds the HTTP port to `127.0.0.1` for the same reason,
and Redis is reachable only on the internal network.

---

## License

MIT. See [LICENSE](LICENSE).
