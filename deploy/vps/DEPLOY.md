# Deploy on a VPS (Ubuntu)

Tested on SurferCloud / any Ubuntu 22.04+ instance.

---

## One-time: Install Docker

```bash
# Copy install_docker.sh to the server, then run:
bash install_docker.sh
newgrp docker
docker --version && docker compose version
```

---

## Setup

```bash
# Create a folder for the executor files
mkdir -p ~/executor
cd ~/executor

# Create the compose file
nano docker-compose.yml
# Paste contents of deploy/vps/docker-compose.yml → Ctrl+O Enter Ctrl+X

# Create the env file
nano .env
# Paste contents of deploy/vps/.env.example, fill in all values → Ctrl+O Enter Ctrl+X
```

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
docker compose ps              # both redis and executor should be Up
curl http://localhost:8000/healthz
```

---

## Common commands

| Action | Command |
|--------|---------|
| Stop | `docker compose down` |
| Restart executor only | `docker compose restart executor` |
| View logs | `docker compose logs -f executor` |
| Update image version | edit `docker-compose.yml` tag, then `docker compose pull && docker compose up -d` |

---

## Updating the image

1. On your local machine: bump `TAG` in `build_and_push.sh` and run it.
2. On the server: update the image tag in `~/executor/docker-compose.yml`.
3. Then:
   ```bash
   cd ~/executor
   docker compose pull
   docker compose up -d
   ```

---

## Notes

- Redis data is ephemeral (no volume). On restart BullMQ queues are empty — the WS listener re-subscribes and new events queue normally.
- Logs are capped at 50MB × 3 files.
- Both containers restart automatically on crash (`restart: always`).
