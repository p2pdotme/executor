# Security Policy

## Reporting a vulnerability

Report security issues privately to **dev@p2p.me**. Do not open a public issue,
pull request, or Discord message describing the problem.

Please include:

- what the issue is and which component is affected (executor service, deploy
  config, container image, …),
- the steps needed to reproduce or verify it,
- the impact you believe it has.

We aim to acknowledge a report within **72 hours** and to give a remediation
timeline with that acknowledgment. Please give us a reasonable window to ship a
fix before disclosing publicly.

## Scope

This policy covers this repository: the executor worker, its deploy manifests
(`deploy/`), and the container image built from `dockerfile`. Issues in the
on-chain contracts, the frontend, or other P2P.me services should still be sent
to the same address — we will route them.

## Security model of this service

The executor is a **private worker, not an API**. Understanding that is enough
to judge most reports:

- **Signing keys come from the environment only.** Each of the five role
  wallets (toggle, assign, sweeper, cashback, keeper) plus the funding wallet is
  read from an env var at boot. The service never generates a wallet, and never
  writes key material to Redis, disk, or logs. A missing key is a hard boot
  failure. Rotation = update the env var and restart.
- **No public HTTP surface.** The only route served is `GET /healthz`, which
  returns a fixed string. There are no debug, registry, or order-inspection
  routes. The service should be deployed **without a public domain** — on
  Railway leave the service private, on a VPS keep the port bound to loopback
  as `deploy/vps/docker-compose.yml` does.
- **Redis holds queues and the tracked-order set — never secrets.** It still
  must not be world-reachable: use an authenticated (and, off-host, TLS)
  connection. The service refuses to start against an unauthenticated Redis on a
  non-private host unless `ALLOW_INSECURE_REDIS=true` is set explicitly.
- **Outbound alerts are scrubbed.** Discord webhook payloads and log lines pass
  through a redactor that masks RPC API keys, webhook tokens and anything shaped
  like a private key, so an upstream error string cannot carry a credential into
  a chat channel.

## What we consider out of scope

- Findings that require an attacker to already hold the deployment's env vars or
  host access — that is game over by design.
- Reports against a deployment that has been given a public domain contrary to
  the guidance above; tell us about the deployment, not the endpoint.
- Missing security headers on `/healthz`; it serves no user content and sets no
  cookies.
