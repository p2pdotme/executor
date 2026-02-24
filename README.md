# **p2pme-executor**

Lightweight, event-driven + schedule-based **contract automation** for **P2P.me**.
Listens to on-chain events, runs scheduled jobs (merchant cleanup, order sweeper), and **executes contract calls** via dedicated executor wallets using **ethers.js**, **BullMQ**, **Redis** and **Express**.
Runs fully inside **Akash** with Redis sidecar.

---

## **Table of Contents**

* [What it does](#what-it-does)
* [Architecture](#architecture)
* [Prerequisites](#prerequisites)
* [Environment Variables](#environment-variables)
* [Secrets and .env](#secrets-and-env)
* [Quick Start (Local)](#quick-start-local)
* [How it works](#how-it-works)
* [API endpoints](#api-endpoints)
* [Deployment (Akash)](#deployment-akash)
* [Testing](#testing)
* [License](#license)

---

## **What it does**

### **1. Blockchain event listening**

Subscribes to the Diamond contract on Base (WebSocket).

Handled events:

* **OrderPlaced** — Triggers remove-non-eligible-merchants (immediate) and assign-merchants (delayed).

### **2. Scheduled jobs**

* **Toggle schedule** — Remove non-eligible merchants per currency every 30 minutes.
* **Order sweeper** — Auto-cancel expired orders every 1 minute (uses tracked order IDs from Redis).
* **Order scanner** — Fetches pending orders from chain and seeds the sweeper.

### **3. Queue-driven execution**

* Listener receives event → enqueues job (toggle or assign).
* Schedulers enqueue toggle-schedule and order-sweeper jobs.
* Workers consume jobs and execute contract calls with the correct executor wallet.
* Separate private keys per responsibility (toggle, assign, toggle-schedule, order-sweeper); balance checks and Telegram alerts on failure/success.

### **4. HTTP API**

* Health check, registry of automations, tx debug by hash, list tracked orders.

---

## **Architecture**

```
src/
│
├── listeners/              # On-chain event listeners
│   ├── orderPlaced.ts      # OrderPlaced → toggle + assign jobs
│   ├── utils.ts            # Resolve order from event/chain
│   └── index.ts            # startListeners()
│
├── schedulers/             # BullMQ repeatable jobs
│   ├── toggleSchedule.ts   # 30m removeNonEligibleMerchants
│   ├── orderSweeper.ts     # 1m autoCancelExpiredOrders
│   ├── orderScanner.ts    # Pending orders → Redis
│   └── index.ts            # startSchedulers()
│
├── queue/                  # BullMQ queues + workers
│   ├── index.ts           # Queues + connection (REDIS_URL)
│   ├── handlers.ts        # Contract job handlers
│   ├── types.ts           # Job payload types
│   └── workers/           # Per-responsibility workers
│       ├── toggleWorker.ts
│       ├── assignWorker.ts
│       ├── toggleScheduleWorker.ts
│       ├── orderSweeperWorker.ts
│       └── orderScannerWorker.ts
│
├── helpers/                # Shared (ABI, config, provider, alerts, logger)
├── utils/                  # orderTracker, fetchPendingOrders
│
└── index.ts                # App bootstrap (Express + listeners + schedulers + workers)
```

### **Redis**

* Runs as a sidecar service (Docker Compose locally; Akash sidecar in production).
* Queues: `toggle-calls`, `assign-calls`, `toggle-schedule-calls`, `order-sweeper-calls`, `order-scanner-calls`.
* Order tracking key: `autocancel:orders` (set of order IDs for sweeper).

### **Single container responsibilities**

* Express HTTP server (health, registry, tx debug, orders).
* WebSocket blockchain listener.
* Schedulers (repeatable jobs).
* Queue workers (contract execution).

All in **one container**, with Redis as sidecar.

---

## **Prerequisites**

* **Node.js** 20 (for local dev or building).
* **Docker** (for local stack and for building the image).
* **Redis** (included via Docker Compose locally; sidecar on Akash).
* **Akash** account and CLI (optional; only if you deploy to Akash).

---

## **Environment Variables**

Put these in `.env` for local testing and in Akash SDL `env:` for production.

### **Core**

```
REDIS_URL=redis://redis:6379
ALCHEMY_API_KEY=
DIAMOND_ADDRESS=
```

`REDIS_URL` is optional; default is `redis://redis:6379` (Docker Compose). Use `redis://localhost:6379` when running the app on the host with Redis locally.

### **Executor wallets (separate key per responsibility)**

```
TOGGLE_EXECUTOR=
ASSIGN_EXECUTOR=
ASSIGN_DELAY_IN_SECONDS=90
TOGGLE_SCHEDULE_EXECUTOR=
ORDER_SWEEPER_EXECUTOR=
```

### **OnFail Telegram**

```
TELEGRAM_ONFAIL_BOT_TOKEN=
TELEGRAM_ONFAIL_CHANNEL_ID=
TELEGRAM_ONFAIL_TOPIC_ID=
TELEGRAM_ONSUCCESS_TOPIC_ID=
TELEGRAM_BALANCE_TOPIC_ID=
```

### **Balance safety**

```
MIN_BASE_BALANCE_ETH=0.005
```

### **Server**

```
PORT=8000
```

See [.env.example](.env.example) for the full set.

### **Where to get credentials**

* **ALCHEMY_API_KEY** — [Alchemy](https://www.alchemy.com/) (Base chain).
* **DIAMOND_ADDRESS** — The Diamond contract on Base used by P2P.me.
* **TELEGRAM_*** — Create bots with [BotFather](https://t.me/BotFather); use your channel/group IDs and topic IDs for threads.
* Executor private keys — Dedicated wallets with minimal balance; one per job type (toggle, assign, toggle-schedule, order-sweeper).

---

## **Secrets and .env**

**Do not commit secrets.** Never commit `.env`, `deploy.final.yml`, `prev.yml`, or any file that contains real API keys, private keys, or tokens. Use `.env.example` as a template only; copy it to `.env` locally and fill in values. The repo’s `.gitignore` excludes `.env`, `deploy.final.yml`, and `prev.yml`.

---

## **Quick Start (Local)**

### 1. Copy example env

```bash
cp .env.example .env
```

Edit `.env` and set at least the core variables (and executor keys + Telegram if you want full behaviour).

### 2. Make sure Docker Desktop is running

Login if required.

### 3. Run

```bash
./test.sh
```

**What it does:**

1. `npm run build`
2. Builds Docker image `executor:local`
3. Runs Docker Compose in foreground (Redis + executor).
4. Press **Ctrl+C** to stop.

### 4. Health check

```bash
curl http://localhost:8000/healthz
```

### Run without Docker

If you prefer to run the app on the host (e.g. for development):

1. Copy `.env.example` to `.env` and fill in at least the core variables and executor keys.
2. Set `REDIS_URL=redis://localhost:6379` in `.env`.
3. Start Redis (e.g. `docker run -d -p 6379:6379 redis:7-alpine` or a local Redis on port 6379).
4. Install and run:

   ```bash
   npm install
   npm run dev
   ```

   Or for a production-style run: `npm run build && npm run start`.
5. Health: `GET http://localhost:8000/healthz`.

---

## **How it works**

### **1. Listener flow**

1. WebSocket receives **OrderPlaced**.
2. Listener resolves order (event + chain), tracks order ID for sweeper.
3. Enqueues **ToggleMerchantsOffline** (delay 0) and **AssignMerchants** (delay e.g. 90s).
4. Workers consume jobs and call the Diamond contract with the correct executor wallet.

### **2. Scheduler flow**

1. **Toggle schedule** — Every 30m, enqueues remove-non-eligible-merchants per currency; worker executes.
2. **Order sweeper** — Every 1m, reads tracked order IDs from Redis, fetches expired ones, enqueues auto-cancel jobs; worker executes.
3. **Order scanner** — Fetches pending orders from chain and adds their IDs to Redis for the sweeper.

### **3. Worker responsibilities**

* Match job name → handler (e.g. `removeNonEligibleMerchants`, `assignMerchants`, `autoCancelExpiredOrders`).
* Execute contract call with the right executor key.
* Balance checks and Telegram alerts (OnFail / OnSuccess / Balance) on failure or low balance.

---

## **API endpoints**

| Method | Path | Description |
|--------|------|-------------|
| GET | `/healthz` | Liveness. |
| GET | `/registry` | JSON list of contract automations (keys, functions, triggers). |
| GET | `/tx/:hash` | Fetch transaction and receipt; attempt to resolve revert reason on failure. |
| GET | `/orders` | List currently tracked order IDs (for sweeper). |

---

## **Deployment (Akash)**

This repo is set up so you can run your own instance on [Akash](https://akash.network/). The image and placement in `deploy.yml` are **examples**; use your own registry and provider.

### 1. Build and push your Docker image

Use your own registry and tag. You can override defaults:

```bash
IMAGE_NAME=your-dockerhub-user/p2pme-executor TAG=v0.1.0 ./build_and_push.sh
```

(Without env vars, the script uses `keccak002/p2pme-executor` and the default tag.)

### 2. Update `deploy.yml` for your deployment

* Set the `image:` for the `executor` service to match the image you pushed (e.g. `your-dockerhub-user/p2pme-executor:v1.0.0`). Keep it in sync with the tag you use in step 1.
* The `placement` section (e.g. `dcloud`) and `pricing` are examples. Choose your own Akash provider and adjust `placement` and `pricing` in `deploy.yml` to match.

### 3. Generate SDL

Put your env values in `.env`, then:

```bash
./generate_deploy.sh
```

This produces `deploy.final.yml` with `${VAR}` replaced from `.env`. **Do not commit this file** (it will contain your secrets).

### 4. Upload to Akash UI

Upload `deploy.final.yml` in the Akash UI to create or update your deployment. The stack includes:

* `redis` service (sidecar).
* `executor` main container.

Both run inside one deployment.

---

## **Testing**

* Run `npm run build` to ensure the project compiles.
* Run `./test.sh` to build and run the full stack (Redis + executor) locally; then hit `GET http://localhost:8000/healthz` and `GET http://localhost:8000/registry`.

---

### Troubleshooting

* **Redis connection refused** — Ensure Redis is running (Docker Compose or local). When running the app on the host, set `REDIS_URL=redis://localhost:6379`.
* **Missing env** — App throws at startup if required env vars are missing; check `.env` and [Environment Variables](#environment-variables).
* **Telegram delays** — Usually Telegram API timeout; handlers retry.

---

## **License**

MIT. See [LICENSE](LICENSE). For contribution guidelines, see [CONTRIBUTING.md](CONTRIBUTING.md).
