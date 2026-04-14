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

**Optional subwallet keys** (`TOGGLE_EXECUTOR`, `ASSIGN_EXECUTOR`, `ORDER_SWEEPER_EXECUTOR`):
- If set: those private keys are used on every boot.
- If not set: keys are auto-generated on first boot and persisted in the Redis volume. They survive restarts automatically.

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
curl http://localhost:8000/orders     # tracked order IDs
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

Wallet keys in Redis survive the update — subwallet keys are never lost across restarts or image updates as long as the `redis_data` volume exists.

---

## Wallet key persistence

Auto-generated wallet keys are stored in the Redis `redis_data` Docker volume. This volume persists across:
- Container restarts
- `docker compose up -d` (image updates)

The volume is only lost if you run `docker compose down -v`. If that happens, the executor generates new wallets on next boot — you'll see the new addresses in Discord and will need to fund them again.

To avoid this risk, set `TOGGLE_EXECUTOR`, `ASSIGN_EXECUTOR`, and `ORDER_SWEEPER_EXECUTOR` explicitly in `.env` — then keys are always loaded from env, never from Redis.

---

## Rotating a subwallet

1. Generate a new private key for the role you want to rotate.
2. Add it to `~/.executor/.env`:
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
