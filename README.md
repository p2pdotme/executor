# p2pme-executor

Event-driven + schedule-based contract automation for P2P.me on Base. Listens to on-chain events, runs scheduled jobs (order sweeper, order scanner), and executes contract calls via dedicated executor wallets. Uses ethers.js v6, BullMQ, Redis, Express. Runs on Akash with a Redis sidecar.

---

## Table of Contents

- [What it does](#what-it-does)
- [Architecture](#architecture)
- [Wallet management](#wallet-management)
- [Environment variables](#environment-variables)
- [Dry run mode](#dry-run-mode)
- [Quick start (local)](#quick-start-local)
- [How it works](#how-it-works)
- [API endpoints](#api-endpoints)
- [Deployment (Akash)](#deployment-akash)
- [License](#license)

---

## What it does

1. **Event listening** — Subscribes to the Diamond contract on Base (WebSocket). On `OrderPlaced`, immediately enqueues `ToggleMerchantsOffline` and enqueues `AssignMerchants` after a configurable delay.
2. **Order sweeper** — Every 1 minute: batch-checks all tracked orders via Multicall3, untracking completed/cancelled ones and auto-cancelling expired ones.
3. **Order scanner** — Every 1 hour: rescans the last 2 500 blocks to catch any orders the WS listener may have missed.
4. **Auto-funded wallets** — Three subwallets (toggle, assign, sweeper) are managed automatically. The funding wallet tops them up whenever any drops below the minimum balance. Discord alerts go to three dedicated channels (success / fail / balance).
5. **HTTP API** — Health, registry, tx debug by hash, list tracked orders.

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
│   ├── walletManager.ts# Subwallet lifecycle: load/generate/persist, auto-fund
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

The executor uses **three subwallets** (toggle, assign, sweeper) plus one **funding wallet**. You never need to manage subwallet keys manually.

### Priority on every boot

```
env var set?  →  use it directly (authoritative)
              ↓ no
Redis has key?  →  load from previous boot (persisted key)
               ↓ no
Generate fresh wallet, save to Redis, log the address
```

### To bring your own wallets

Set the optional env vars:

```env
TOGGLE_EXECUTOR=0x...privatekey
ASSIGN_EXECUTOR=0x...privatekey
ORDER_SWEEPER_EXECUTOR=0x...privatekey
```

If these are set, they are used on every boot. If not set, the executor creates and persists wallets in Redis automatically.

### To rotate a wallet

Update the env var and redeploy. The new key is used immediately; the Redis entry for that role is ignored when an env var is present.

### Funding

Only `FUNDING_EXECUTOR` is required. The funding wallet tops up any subwallet that drops below `MIN_BASE_BALANCE_ETH` (default 0.005 ETH), sending enough to bring it to 0.02 ETH. On every boot and every 10 minutes, balances are checked and Discord alerts are sent to the balance channel.

On first boot, Discord (success channel) receives all wallet addresses so you know what to fund.

---

## Environment variables

Copy `.env.example` to `.env` for local dev. For Akash, set these in the SDL `env:` block.

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

### Optional — bring your own subwallet keys

| Variable | Description |
|---|---|
| `TOGGLE_EXECUTOR` | Private key for the toggle wallet (if not set, auto-managed) |
| `ASSIGN_EXECUTOR` | Private key for the assign wallet (if not set, auto-managed) |
| `ORDER_SWEEPER_EXECUTOR` | Private key for the sweeper wallet (if not set, auto-managed) |

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

## API endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/healthz` | Liveness check |
| GET | `/registry` | All registered contract automations |
| GET | `/tx/:hash` | Tx + receipt + revert reason |
| GET | `/orders` | Order IDs currently tracked by sweeper |

---

## Deployment (Akash)

1. Fill in all values in `deploy.final.yml` (see comments in the file). **Do not commit the filled-in file to git.**
2. Build and push the image: bump `TAG` in `build_and_push.sh` and run it.
3. Update the image tag in `deploy.final.yml`.
4. Upload `deploy.final.yml` in [Akash Console](https://console.akash.network). Stack: redis + executor.

---

## License

MIT. See [LICENSE](LICENSE).
