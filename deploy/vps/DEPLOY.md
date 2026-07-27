# Deploy on a VPS (Ubuntu)

Tested on Ubuntu 22.04+. Requires Docker and Docker Compose.

---

## One-time: Install Docker

```bash
bash install_docker.sh
newgrp docker
docker --version && docker compose version
```

---

## Setup

```bash
mkdir -p ~/executor
cd ~/executor

# Copy the compose file
# Paste contents of deploy/vps/docker-compose.yml
nano docker-compose.yml

# Create the env file from the example
# Paste contents of deploy/vps/.env.example, fill in all values
nano .env
```

**Required values in `.env`:**

| Variable | Description |
|---|---|
| `ALCHEMY_API_KEY` | Alchemy key for Base mainnet |
| `DIAMOND_ADDRESS` | Diamond contract on Base |
| `FUNDING_EXECUTOR` | Private key of the funding wallet |
| `DISCORD_ONSUCCESS_WEBHOOK_URL` | Discord webhook — success alerts |
| `DISCORD_ONFAIL_WEBHOOK_URL` | Discord webhook — fail / WS error alerts |
| `DISCORD_BALANCE_WEBHOOK_URL` | Discord webhook — balance + auto-fund alerts |
| `ASSIGN_DELAY_IN_SECONDS` | Seconds to wait before assigning merchants (e.g. `90`) |
| `TOGGLE_EXECUTOR` | Private key of the toggle wallet |
| `ASSIGN_EXECUTOR` | Private key of the assign wallet |
| `ORDER_SWEEPER_EXECUTOR` | Private key of the sweeper wallet |
| `CASHBACK_EXECUTOR` | Private key of the cashback wallet |
| `KEEPER_EXECUTOR` | Private key of the daily keeper wallet |

Every signing key is read from `.env` and nowhere else — the executor never
generates a wallet and never writes a key to Redis or disk. A missing key is a
hard boot failure. Redis holds the BullMQ queues and the tracked-order set only.

---

## Start

```bash
cd ~/executor
docker compose pull
docker compose up -d
docker compose logs -f executor
```

---

## Verify

```bash
docker compose ps                     # both redis and executor should show Up
curl http://localhost:8000/healthz    # should return: I'm alive
```

On first boot, Discord (success channel) receives all wallet addresses and balances. Fund the subwallets shown — the funding wallet will keep them topped up automatically from that point.

---

## Common commands

| Action | Command |
|---|---|
| Stop | `docker compose down` |
| Restart executor only | `docker compose restart executor` |
| View live logs | `docker compose logs -f executor` |
| Update image | edit image tag in `docker-compose.yml`, then `docker compose pull && docker compose up -d` |
| Check wallet balances | watch Discord balance channel or `GET /healthz` |

---

## Updating to a new version

1. On your local machine: bump `TAG` in `build_and_push.sh` and run it.
2. On the server: update the image tag in `~/executor/docker-compose.yml`.
3. Then:

```bash
cd ~/executor
docker compose pull
docker compose up -d
```

Wallet keys live in `.env`, so they are unaffected by image updates. The
`redis_data` volume only carries queue state and the tracked-order set — losing
it costs at most one sweeper/scanner cycle, never a key.

---

## Rotating a subwallet

1. Generate a new private key for the role you want to rotate.
2. Replace its value in `~/executor/.env`:
   ```
   TOGGLE_EXECUTOR=0x<new_private_key>
   ```
3. Restart the executor:
   ```bash
   docker compose restart executor
   ```
4. Fund the new wallet address (shown in Discord on restart).

---

## Notes

- The HTTP port `8000` is bound to `127.0.0.1` only — not exposed to the public internet. Use a reverse proxy (nginx, Caddy) if you need external access.
- Log rotation: executor logs capped at 50 MB × 3 files; Redis logs at 10 MB × 3 files.
- Both containers restart automatically on crash (`restart: always`).
