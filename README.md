# p2pme-executor

Event-driven + schedule-based contract automation for P2P.me on Base. Listens to on-chain events, runs scheduled jobs (order sweeper, order scanner), and executes contract calls via dedicated executor wallets. Uses ethers.js v6, BullMQ and Redis. Runs as a private worker (Railway or Docker Compose) with a Redis sidecar; the only thing it serves is a `/healthz` liveness probe.

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
5. **Auto-funded wallets** — Five subwallets (toggle, assign, sweeper, cashback, keeper) are managed automatically. The funding wallet tops them up whenever any drops below the minimum balance. Discord alerts go to three dedicated channels (success / fail / balance).
6. **Liveness probe** — `GET /healthz` and nothing else. There is no API.

---

## Architecture

```
src/
├── listeners/          # OrderPlaced WS → enqueue toggle + assign jobs
├── schedulers/         # Repeating BullMQ jobs (sweeper every 1m, scanner every 1h)
├── queue/
│   ├── index.ts        # Queue definitions + addToggleJob / addAssignJob helpers
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

### Required — subwallet keys

All five are mandatory; the executor refuses to boot if any is missing.

| Variable | Description |
|---|---|
| `TOGGLE_EXECUTOR` | Private key for the toggle wallet |
| `ASSIGN_EXECUTOR` | Private key for the assign wallet |
| `ORDER_SWEEPER_EXECUTOR` | Private key for the sweeper wallet |
| `CASHBACK_EXECUTOR` | Private key for the cashback wallet. Its address must be whitelisted on the cashback integrator via `setCreditIssuer(addr, true)` before `issueCredit` calls land — the startup Discord message prints the address explicitly so you know what to whitelist. |
| `KEEPER_EXECUTOR` | Private key for the daily keeper wallet (`approveUnstakeBatch` + `blacklistInactiveMerchants`) |

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
