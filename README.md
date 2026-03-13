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

See [.env.example](.env.example) (root, for local dev) or [deploy/vps/.env.example](deploy/vps/.env.example) (VPS/production).

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
2. Run `./test.sh` (builds app + image, runs Redis + executor via `deploy/local/docker-compose.yml`). Or run Redis locally, set `REDIS_URL=redis://localhost:6379`, then `npm install && npm run dev`.
3. Health: `GET http://localhost:8000/healthz`.

---

## How it works
[![](https://mermaid.ink/img/pako:eNqNU8tu00AU_ZWrWbVSGtrEIYmFkBr3QaW-0kSyRM1iMr5xTJ2ZMDNuA2137IvoAlEWiB2LLpBYwJpP4QfgE7hjp6VBXTArz51zzj334VMmVIzMZ8NMnYgR1xb6a5EEOp1g4TBiPz9c_vp-AR1uEDqZEkcESiWspXysZAyBklZzYSP2bDGSJdHkg0TzyQhW9_eBJH5_fPMVcIoit0qDIAYpoCZKiXcnTjUKmyoJ2wd_o2GvoF9-ghAHPUqOFrZTY5HosKdj1PsZFxgDHqO0c4K94Ilzf_EFemKEcZ6hNmBOECdE_fENjODyXxPdwzLdNXTyLNvpQjfHHA1YlSQZOhY3Jk1kwb9P6o5W6LJfvXe9C5U-ctn_W-ZuA2Bp6fFZxFC-cF7guRqYiJ1Bd67SGYhamGudyuQ-WNeBICwDKOObaR2sr231Dhdc4e9eO7sHGKdEXpzZ6G8uFF15ew19zJAmOy6H7R73djdWt7ZLwNVn2JMbPM1glZo9txGdYOZQyaVyf4qBFRbDXonpwqMSY2hLEB7AEK0YOUThsASFMx079UHjWB3jrpLrWZqkA-ps2dYd1JSD1IHTwgVcCszWpxNasNipdYJ5KZMLgYbAznThqL95i6jOXMOQ6so1uueyZlZhiU5j5ludY4WNUY-5u7JTRyaHIxwT3KfPmOujiEXynDgTLp8qNb6haZUnI-YPeWbolk9ibpF-Ldfk26imYaEOVC4t871mrRBh_imbMn-l0aw2617d8xqth1694XkV9pLCrVq13fRajdbySqveWm7XzyvsVZF3ufqw3m5SsNGuNWrtWrt5_geNGFLL?type=png)](https://mermaid.live/edit#pako:eNqNU8tu00AU_ZWrWbVSGtrEIYmFkBr3QaW-0kSyRM1iMr5xTJ2ZMDNuA2137IvoAlEWiB2LLpBYwJpP4QfgE7hjp6VBXTArz51zzj334VMmVIzMZ8NMnYgR1xb6a5EEOp1g4TBiPz9c_vp-AR1uEDqZEkcESiWspXysZAyBklZzYSP2bDGSJdHkg0TzyQhW9_eBJH5_fPMVcIoit0qDIAYpoCZKiXcnTjUKmyoJ2wd_o2GvoF9-ghAHPUqOFrZTY5HosKdj1PsZFxgDHqO0c4K94Ilzf_EFemKEcZ6hNmBOECdE_fENjODyXxPdwzLdNXTyLNvpQjfHHA1YlSQZOhY3Jk1kwb9P6o5W6LJfvXe9C5U-ctn_W-ZuA2Bp6fFZxFC-cF7guRqYiJ1Bd67SGYhamGudyuQ-WNeBICwDKOObaR2sr231Dhdc4e9eO7sHGKdEXpzZ6G8uFF15ew19zJAmOy6H7R73djdWt7ZLwNVn2JMbPM1glZo9txGdYOZQyaVyf4qBFRbDXonpwqMSY2hLEB7AEK0YOUThsASFMx079UHjWB3jrpLrWZqkA-ps2dYd1JSD1IHTwgVcCszWpxNasNipdYJ5KZMLgYbAznThqL95i6jOXMOQ6so1uueyZlZhiU5j5ludY4WNUY-5u7JTRyaHIxwT3KfPmOujiEXynDgTLp8qNb6haZUnI-YPeWbolk9ibpF-Ldfk26imYaEOVC4t871mrRBh_imbMn-l0aw2617d8xqth1694XkV9pLCrVq13fRajdbySqveWm7XzyvsVZF3ufqw3m5SsNGuNWrtWrt5_geNGFLL)

- **On `OrderPlaced`** — WS listener tracks the order ID in Redis, immediately enqueues `ToggleMerchantsOffline`, and enqueues `AssignMerchants` with a configurable delay.
- **Every 1 min** — Sweeper checks all tracked orders: untrack completed/cancelled ones, auto-cancel expired ones.
- **Every 1 hour** — Scanner resyncs the last 2500 blocks to catch any orders the WS listener may have missed.
- All contract writes go through `safeSend()` — balance check → staticCall simulation → send → wait 1 confirmation → Telegram alert.

---

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Liveness. |
| GET | `/registry` | Contract automations (keys, functions, triggers). |
| GET | `/tx/:hash` | Tx + receipt; revert reason on failure. |
| GET | `/orders` | Tracked order IDs for sweeper. |

---

## Deployment

### Any VPS (Ubuntu)

See [deploy/vps/DEPLOY.md](deploy/vps/DEPLOY.md) for full step-by-step instructions.

```bash
# On the server
mkdir ~/executor
# copy deploy/vps/docker-compose.yml and deploy/vps/.env.example to ~/executor/
nano ~/executor/.env       # fill in values
docker compose -f ~/executor/docker-compose.yml up -d
```

### Akash

1. Build and push: bump `TAG` in `build_and_push.sh` and run it.
2. Update image tag in `deploy/akash/deploy.yml`.
3. Generate SDL: `bash deploy/akash/generate_deploy.sh` → `deploy/akash/deploy.final.yml` (do not commit).
4. Upload `deploy.final.yml` in Akash Console UI. Stack: redis + executor.

---

## Testing

* `npm run build` — ensure it compiles.
* `./test.sh` — full stack; then `GET /healthz` and `GET /registry`.
* Use **DRY_RUN=true** to run against mainnet without sending any transactions.

---

## License

MIT. See [LICENSE](LICENSE). [CONTRIBUTING.md](CONTRIBUTING.md).
