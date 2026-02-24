# p2pme-executor

Event-driven + schedule-based contract automation for P2P.me on Base. Listens to on-chain events, runs scheduled jobs (merchant cleanup, order sweeper), and executes contract calls via dedicated executor wallets. Uses ethers.js, BullMQ, Redis, Express. Runs on Akash with Redis sidecar.

---

## Table of Contents

* [What it does](#what-it-does)
* [Architecture](#architecture)
* [Prerequisites](#prerequisites)
* [Environment Variables](#environment-variables)
* [Dry run mode](#dry-run-mode)
* [Secrets and .env](#secrets-and-env)
* [Quick Start (Local)](#quick-start-local)
* [How it works](#how-it-works)
* [API endpoints](#api-endpoints)
* [Deployment (Akash)](#deployment-akash)
* [Testing](#testing)
* [License](#license)

---

## What it does

1. **Blockchain event listening** — Subscribes to Diamond on Base (WebSocket). On **OrderPlaced**, triggers remove-non-eligible-merchants (immediate) and assign-merchants (delayed).
2. **Scheduled jobs** — Toggle schedule (30m), order sweeper (1m), order scanner (seeds Redis for sweeper).
3. **Queue-driven execution** — Workers consume jobs and execute contract calls with the correct executor wallet; balance checks and Telegram alerts.
4. **HTTP API** — Health, registry, tx debug by hash, list tracked orders.

---

## Architecture

```
src/
├── listeners/       # OrderPlaced → toggle + assign jobs
├── schedulers/       # Repeatable jobs (toggle, sweeper, scanner)
├── queue/            # BullMQ queues + workers (handlers call safeSend)
├── helpers/         # config, safeSend, provider, alerts, ABI, logger
├── utils/            # orderTracker, fetchPendingOrders
└── index.ts          # Bootstrap
```

All contract **writes** go through `safeSend()` in `helpers/safeSend.ts`. When **DRY_RUN** is enabled, `safeSend` only runs `staticCall` (simulation) and never sends a transaction.

---

## Prerequisites

Node.js 20+, Docker, Redis. Akash CLI optional for deployment.

---

## Environment Variables

In `.env` for local; in Akash SDL `env:` for production.

### Core

| Variable | Description |
|----------|-------------|
| `REDIS_URL` | Optional. Default `redis://redis:6379`. Use `redis://localhost:6379` when running app on host. |
| `ALCHEMY_API_KEY` | Alchemy API key for Base. |
| `DIAMOND_ADDRESS` | Diamond contract on Base. |

### Executor wallets (one key per responsibility)

| Variable | Description |
|----------|-------------|
| `TOGGLE_EXECUTOR` | Private key for remove-non-eligible-merchants (event + schedule). |
| `ASSIGN_EXECUTOR` | Private key for assignMerchants. |
| `ASSIGN_DELAY_IN_SECONDS` | Delay before assign after OrderPlaced (e.g. 90). |
| `TOGGLE_SCHEDULE_EXECUTOR` | Private key for scheduled toggle. |
| `ORDER_SWEEPER_EXECUTOR` | Private key for order sweeper. |

### OnFail Telegram

`TELEGRAM_ONFAIL_BOT_TOKEN`, `TELEGRAM_ONFAIL_CHANNEL_ID`, `TELEGRAM_ONFAIL_TOPIC_ID`, `TELEGRAM_ONSUCCESS_TOPIC_ID`, `TELEGRAM_BALANCE_TOPIC_ID`.

### Other

| Variable | Description |
|----------|-------------|
| `MIN_BASE_BALANCE_ETH` | Min ETH on Base; alerts below this (default 0.005). |
| `PORT` | HTTP port (default 8000). |
| `DRY_RUN` | Set to `true` to simulate only; no transactions sent. See [Dry run mode](#dry-run-mode). |

See [.env.example](.env.example).

---

## Dry run mode

Set **`DRY_RUN=true`** in `.env` (or in Akash env) to run in **simulation-only** mode:

* Every contract write path goes through `safeSend()`. When `config.dryRun` is true, `safeSend`:
  * Still performs balance checks and uses the same config (including executor keys).
  * Runs only `fn.staticCall(...args)` (ethers simulation); **no transaction is sent**.
  * Logs `safeSend[DRY_RUN]: simulated fn= ... ok` on success or `safeSend[DRY_RUN]: simulation failed` on revert.
  * Does not send Telegram success/fail for the “tx” (no tx hash).
* Use this to verify handlers and config against the chain without spending gas or changing state. All workers (toggle, assign, toggle-schedule, order-sweeper) respect DRY_RUN because they all use `safeSend`.

---

## Secrets and .env

Do not commit `.env`, `deploy.final.yml`, or `prev.yml`. Use `.env.example` as a template. `.gitignore` excludes these.

---

## Quick Start (Local)

1. `cp .env.example .env` and fill in values.
2. Run `./test.sh` (builds app + image, runs Redis + executor with Docker Compose). Or run Redis locally, set `REDIS_URL=redis://localhost:6379`, then `npm install && npm run dev`.
3. Health: `GET http://localhost:8000/healthz`.

---

## How it works

* **Listener** — OrderPlaced → enqueue ToggleMerchantsOffline (delay 0) and AssignMerchants (delay e.g. 90s). Workers call `safeSend` (or simulate when DRY_RUN).
* **Schedulers** — Toggle every 30m; sweeper every 1m (tracked order IDs from Redis); scanner seeds pending orders.
* **Workers** — Match job → handler; execute via `safeSend` (or staticCall only if DRY_RUN).

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Liveness. |
| GET | `/registry` | Contract automations (keys, functions, triggers). |
| GET | `/tx/:hash` | Tx + receipt; revert reason on failure. |
| GET | `/orders` | Tracked order IDs for sweeper. |

---

## Deployment (Akash)

1. Build and push: `IMAGE_NAME=your-user/p2pme-executor TAG=v0.1.0 ./build_and_push.sh`
2. Update `deploy.yml` (image, placement, pricing).
3. Generate SDL: `./generate_deploy.sh` → `deploy.final.yml` (do not commit).
4. Upload `deploy.final.yml` in Akash UI. Stack: redis + executor.

`deploy.yml` includes optional `DRY_RUN=${DRY_RUN}`; set in your env when generating to enable dry run in production deployment.

---

## Testing

* `npm run build` — ensure it compiles.
* `./test.sh` — full stack; then `GET /healthz` and `GET /registry`.
* Use **DRY_RUN=true** to run against mainnet without sending any transactions.

---

## License

MIT. See [LICENSE](LICENSE). [CONTRIBUTING.md](CONTRIBUTING.md).
