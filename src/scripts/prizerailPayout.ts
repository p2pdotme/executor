import dotenv from 'dotenv';
dotenv.config();

import { userInfo } from 'os';
import { getHttpProvider, withTimeout } from '../helpers/provider';
import { redactError } from '../helpers/redact';
import { loadPrizerailConfig, resolveUsdcAddress } from '../prizerail/config';
import { runManualPayout } from '../prizerail/manualPayout';
import { PrizerailStore } from '../prizerail/store';

// Operator CLI for winners the payout worker leaves to a human (prizes over
// $100, Prizerail holds, failed or unconfirmed sends). It never sends
// USDC: approve/retry hand the row back to the payout worker, mark-paid only
// records a transfer after checking it on-chain. It reads the executor's own
// env: PRIZERAIL_API_KEY picks the site and campaign (pr_prod_* → p2p-ramp on
// Base mainnet), DATABASE_URL the ledger, ALCHEMY_API_KEY or RPC_HTTP_URL the
// chain. Run it where the executor runs, so it sees the production env.
//
// ── Production: manual payout, step by step ─────────────────────────────
//
// 1. Open a shell next to the running executor:
//      Railway:  railway ssh --service <executor service>
//      VPS:      cd ~/executor && docker compose exec executor sh
//    then use `bun dist/scripts/prizerailPayout.js` below.
//    (Locally with the prod .env: `bun run prizerail:payout` instead.)
//
// 2. See who is waiting. The header must say [prod · p2p-ramp]:
//      bun dist/scripts/prizerailPayout.js list
//    Each line: <drawingId> #<position>  $amount  status  wallet  reason
//
// 3. Pick the case from the status:
//
//    held, over the $100 cap → let the executor pay it from the prize wallet
//    (needs enough USDC and a little ETH in it):
//      bun dist/scripts/prizerailPayout.js approve <drawingId> <position>
//    It is paid on the next scan (within 5 min); Discord gets "Prize paid".
//
//    held by Prizerail (list says so) → approve refuses. Clear it in the
//    Prizerail portal (identity check / review), then pay by hand (below).
//
//    pay by hand (any held, manual or failed row) → from the prize wallet,
//    send exactly the listed amount of USDC on Base to the listed wallet,
//    wait for it to confirm, then record it:
//      bun dist/scripts/prizerailPayout.js mark-paid <drawingId> <position> <txHash>
//    Refused unless that tx succeeded on Base and moved exactly that USDC
//    amount to that wallet, and is not already recorded for another winner.
//
//    manual (a send may have gone out) → do NOT pay again. Look up the row's
//    tx hash (or the prize wallet's transfers) on basescan.org. If it landed,
//    mark-paid with that hash. If nothing landed, pay by hand and mark-paid.
//
//    failed (rejected before broadcast) → fix the cause from the Discord fail
//    alert (usually ETH or USDC in the prize wallet), then:
//      bun dist/scripts/prizerailPayout.js retry <drawingId> <position>
//
//    unresolved_entrant → no wallet known. See README → "Paying held winners".
//
// 4. Run list again; the row should be gone (paid) or show as pending.
//
// Set PRIZERAIL_OPERATOR=<your name> to label the audit note, otherwise the
// OS user name is written to the row.

const ALCHEMY_NETWORK: Record<number, string> = { 8453: 'base-mainnet', 84532: 'base-sepolia' };

async function main(): Promise<void> {
    const prizerail = loadPrizerailConfig(process.env);
    if (!prizerail) throw new Error('PRIZERAIL_API_KEY is unset — Prizerail is off, nothing to manage');

    const rpcUrl =
        process.env.RPC_HTTP_URL ?? `https://${ALCHEMY_NETWORK[prizerail.chainId]}.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY ?? ''}`;
    const store = new PrizerailStore(prizerail.databaseUrl);
    try {
        const lines = await runManualPayout(process.argv.slice(2), {
            campaign: prizerail.campaignSlug,
            usdcAddress: resolveUsdcAddress(prizerail.chainId),
            actor: process.env.PRIZERAIL_OPERATOR ?? userInfo().username,
            store,
            getReceipt: async (txHash) => {
                const provider = getHttpProvider(rpcUrl);
                const chainId = Number((await withTimeout(provider.getNetwork(), 10_000)).chainId);
                if (chainId !== prizerail.chainId) {
                    throw new Error(`RPC is chain ${chainId} but the ${prizerail.site} site pays on ${prizerail.chainId}`);
                }
                return withTimeout(provider.getTransactionReceipt(txHash), 10_000);
            },
        });
        process.stdout.write(`[${prizerail.site} · ${prizerail.campaignSlug}]\n${lines.join('\n')}\n`);
    } finally {
        await store.close();
    }
}

main().catch((err: unknown) => {
    process.stderr.write(`${redactError(err)}\n`);
    process.exit(1);
});
