# Contributing to p2pme-executor

## Development setup

1. Clone the repo and install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in values.
   - `FUNDING_EXECUTOR` is required (funding wallet private key).
   - Subwallet keys (`TOGGLE_EXECUTOR`, `ASSIGN_EXECUTOR`, `ORDER_SWEEPER_EXECUTOR`) are optional — the executor generates and persists them automatically if not set.
   - Set `DRY_RUN=true` to run against mainnet without sending any transactions.
3. Start Redis and the app:

   **Option A — Docker (recommended)**
   ```bash
   ./test.sh
   ```

   **Option B — host Redis**
   ```bash
   docker run -d -p 6379:6379 redis:7-alpine
   REDIS_URL=redis://localhost:6379 npm run dev
   ```

4. Verify: `GET http://localhost:8000/healthz`

## Code style

- TypeScript, strict mode
- All contract writes go through `safeSend()` in `src/helpers/safeSend.ts` — do not call `sendTransaction` directly
- All batch RPC reads should use Multicall3 (`src/helpers/multicall.ts`) — no serial awaits in loops
- Discord alerts route through `sendOnFail` / `sendOnSuccess` / `sendBalanceAlert` in `src/helpers/alerts.ts`
- Follow existing patterns: helpers in `src/helpers/`, workers in `src/queue/workers/`, listeners in `src/listeners/`

## Before opening a PR

- `npm run build` must pass with zero TypeScript errors
- `npx tsc --noEmit` for a quick check without emitting files
- Do not commit any file containing secrets: `.env`, `deploy.final.yml`, or any file with real private keys / API keys (`.gitignore` covers these)

## Security

If you find a security issue, report it privately to the maintainers rather than in a public issue.
