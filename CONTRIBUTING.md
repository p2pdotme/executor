# Contributing to p2pme-executor

Thanks for your interest in contributing.

## Development setup

1. Clone the repo and install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in values for local testing (use testnet or throwaway keys; never commit `.env`)
3. **Option A — Docker:** Run `./test.sh` (builds app, builds image, runs Redis + executor via Docker Compose).
4. **Option B — Host:** Set `REDIS_URL=redis://localhost:6379` in `.env`, start Redis (e.g. `docker run -d -p 6379:6379 redis:7-alpine`), then `npm run build` and `npm start` or `npm run dev`.

## Code style

- TypeScript with strict mode
- Prefer existing patterns (helpers in `src/helpers`, workers in `src/queue/workers`, listeners in `src/listeners`)

## Pull requests

- Open a PR against `main` with a short description of the change
- Ensure `npm run build` passes
- Do not add or commit any files that contain secrets (`.env`, `deploy.final.yml`, `prev.yml`, or any file with real API keys / private keys)

## Security

If you find a security issue, please report it privately (e.g. via the maintainers or a security contact) rather than in a public issue.
