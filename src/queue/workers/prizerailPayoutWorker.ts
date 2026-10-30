import { Worker } from 'bullmq';
import { Contract, parseUnits } from 'ethers';
import { ExecutorConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import { sendBalanceAlert, sendOnFail, sendOnSuccess } from '../../helpers/alerts';
import { safeSend } from '../../helpers/safeSend';
import { withTimeout } from '../../helpers/provider';
import { WalletManager, WalletRole } from '../../helpers/walletManager';
import { connection } from '../index';
import { initPrizerailPayoutQueue, PRIZERAIL_PAYOUT_QUEUE_NAME } from '../prizerailQueues';
import { PRIZERAIL_PAYOUT_JOB_NAME, PrizerailPayoutJobData } from '../types';
import { getPrizerailStore } from '../../prizerail/db';
import { centsToUsdc6, ERC20_ABI } from '../../prizerail/payout';
import type { PrizerailStore, WinnerRow } from '../../prizerail/store';
import { PRIZERAIL_POLICY, type PrizerailConfig, resolveUsdcAddress } from '../../prizerail/config';
import { formatUsd } from '../../prizerail/winners';

const LOCK_DURATION_MS = 5 * 60_000; // safeSend waits up to 3 min for a receipt
const USDC_DECIMALS = 6;
// A claim with no tx hash and no nonce movement for this long is treated as
// never broadcast and released for a clean retry.
export const UNSENT_GRACE_MS = 10 * 60_000;
// A sent tx with no receipt for this long goes to a human: it was probably
// dropped, but only the chain can say for sure.
export const UNCONFIRMED_DEADLINE_MS = 60 * 60_000;
const BALANCE_ALERT_COOLDOWN_MS = 30 * 60_000;

// Everything the payout logic touches, so tests can drive it with fakes.
export type PayoutDeps = {
    dryRun: boolean;
    campaign: string;
    prizeAddress: string;
    minBalance: bigint;
    store: Pick<
        PrizerailStore,
        'getWinner' | 'claimPayout' | 'releaseClaim' | 'recordSendNonce' | 'recordTxHash' | 'markPaid' | 'markManual' | 'markFailed'
    >;
    balanceOf: (address: string) => Promise<bigint>;
    minedNonce: (address: string) => Promise<number>;
    receiptStatus: (txHash: string) => Promise<0 | 1 | null>;
    /** Broadcast a transfer. Resolves true on confirmed success; onSent fires once the hash is known. */
    transfer: (to: string, amount: bigint, onSent: (hash: string) => Promise<void>) => Promise<boolean>;
    alertSuccess: (msg: string) => Promise<void>;
    alertFail: (msg: string) => Promise<void>;
    alertBalance: (msg: string) => Promise<void>;
    now: () => number;
    /** When the low-balance alert last fired; owned per worker instance. */
    balanceAlert: { lastAt: number };
};

function usdcLabel(units: bigint): string {
    return `${(Number(units) / 1e6).toFixed(2)} USDC`;
}

async function ensureBalance(d: PayoutDeps, needed: bigint): Promise<boolean> {
    const balance = await d.balanceOf(d.prizeAddress);
    if (balance - needed < d.minBalance && d.now() - d.balanceAlert.lastAt > BALANCE_ALERT_COOLDOWN_MS) {
        d.balanceAlert.lastAt = d.now();
        await d.alertBalance(
            `🎟️ Prize wallet \`${d.prizeAddress}\` low: ${usdcLabel(balance)} (floor ${usdcLabel(d.minBalance)}, next payout ${usdcLabel(needed)})`,
        );
    }
    return balance >= needed;
}

/**
 * A row is 'paying': an earlier attempt claimed it and may or may not have
 * broadcast. Settle it from the chain, never by sending again.
 *  - hash known → receipt decides (paid / manual), or wait longer.
 *  - no hash → compare the wallet's mined nonce with the one recorded at
 *    claim time. Moved = something from this wallet was mined after the
 *    claim (single writer, so almost certainly our transfer) → manual.
 *    Unmoved past the grace period → nothing was broadcast → release.
 */
export async function reconcileInFlight(d: PayoutDeps, row: WinnerRow): Promise<void> {
    const { campaign, drawingId, position, txHash } = row;
    const age = d.now() - row.updatedAt;
    const tag = `${drawingId}#${position}`;

    if (txHash) {
        const status = await d.receiptStatus(txHash);
        if (status === 1) {
            await d.store.markPaid(campaign, drawingId, position, txHash);
            logger.info(`prizerail-payout: ${tag} confirmed on reconcile tx=${txHash}`);
            return;
        }
        if (status === 0) {
            await d.store.markManual(campaign, drawingId, position, `tx ${txHash} reverted`);
            await d.alertFail(`Prizerail payout ${tag}: tx ${txHash} reverted — set to manual`);
            return;
        }
        if (age > UNCONFIRMED_DEADLINE_MS) {
            await d.store.markManual(campaign, drawingId, position, `tx ${txHash} unconfirmed after ${Math.round(age / 60_000)} min`);
            await d.alertFail(`Prizerail payout ${tag}: tx ${txHash} still unconfirmed — set to manual, verify on-chain`);
            return;
        }
        throw new Error(`payout tx ${txHash} still pending`); // retry later
    }

    if (row.sendNonce === null) {
        await d.store.markManual(campaign, drawingId, position, 'claimed with no nonce or hash recorded — verify by hand');
        await d.alertFail(`Prizerail payout ${tag}: claimed with no send record — set to manual`);
        return;
    }
    const mined = await d.minedNonce(d.prizeAddress);
    if (mined > row.sendNonce) {
        await d.store.markManual(campaign, drawingId, position, `nonce moved ${row.sendNonce}→${mined} after claim with no hash — a transfer may have been mined`);
        await d.alertFail(`Prizerail payout ${tag}: wallet nonce moved after an unrecorded send — set to manual, verify on-chain`);
        return;
    }
    if (age > UNSENT_GRACE_MS) {
        await d.store.releaseClaim(campaign, drawingId, position, 'no broadcast detected after claim — released for retry');
        logger.warn(`prizerail-payout: ${tag} released after ${Math.round(age / 60_000)} min with no broadcast`);
        return;
    }
    throw new Error(`payout ${tag} claimed ${Math.round(age / 1000)}s ago with no hash yet`); // retry later
}

export async function payWinner(d: PayoutDeps, data: PrizerailPayoutJobData): Promise<void> {
    const { campaign, drawingId, position } = data;
    const tag = `${drawingId}#${position}`;
    const existing = await d.store.getWinner(campaign, drawingId, position);
    if (!existing) {
        logger.warn(`prizerail-payout: no ledger row for ${tag}`);
        return;
    }
    if (existing.payoutStatus === 'paying') {
        if (d.dryRun) {
            logger.info(`prizerail-payout[DRY_RUN]: ${tag} is in-flight; not touching it`);
            return;
        }
        return reconcileInFlight(d, existing);
    }
    if (existing.payoutStatus !== 'pending') {
        logger.debug(`prizerail-payout: ${tag} is ${existing.payoutStatus}, nothing to do`);
        return;
    }

    const amount = centsToUsdc6(existing.amountCents);
    if (d.dryRun) {
        logger.info(`prizerail-payout[DRY_RUN]: would send ${usdcLabel(amount)} to ${existing.wallet} for ${tag}`);
        return;
    }

    const row = await d.store.claimPayout(campaign, drawingId, position);
    if (!row || !row.wallet) return; // lost the race or wallet vanished

    // Nothing has been broadcast yet, so an RPC blip on these reads releases
    // the claim. Left 'paying' with no nonce, the retry would set it to manual.
    let funded: boolean;
    let nonce: number;
    try {
        funded = await ensureBalance(d, amount);
        nonce = await d.minedNonce(d.prizeAddress);
    } catch (err: unknown) {
        await d.store.releaseClaim(campaign, drawingId, position, `pre-send RPC read failed: ${(err as Error)?.message ?? err}`);
        throw err; // retry with backoff
    }

    if (!funded) {
        await d.store.releaseClaim(campaign, drawingId, position, 'insufficient USDC in prize wallet');
        throw new Error('prize wallet has insufficient USDC'); // retry with backoff
    }

    // Nonce snapshot BEFORE broadcast: the only way to tell "never sent" from
    // "sent but the RPC lost the hash" if we die or error mid-send.
    await d.store.recordSendNonce(campaign, drawingId, position, nonce);

    let sentHash: string | null = null;
    let ok: boolean;
    try {
        ok = await d.transfer(row.wallet, amount, async (hash) => {
            sentHash = hash;
            await d.store.recordTxHash(campaign, drawingId, position, hash);
        });
    } catch (err: unknown) {
        // Ambiguous: the tx may or may not have left. Keep the row 'paying';
        // the next attempt reconciles from the chain instead of re-sending.
        logger.error(`prizerail-payout: ${tag} send errored (${sentHash ? 'hash known' : 'no hash'}): ${(err as Error)?.message ?? err}`);
        throw err;
    }

    if (ok && sentHash) {
        await d.store.markPaid(campaign, drawingId, position, sentHash);
        await d.alertSuccess(`🎟️ Prize paid: ${formatUsd(row.amountCents)} → \`${row.wallet}\` (draw ${drawingId} #${position})`);
        return;
    }
    if (sentHash) {
        await d.store.markManual(campaign, drawingId, position, 'tx sent but reverted or unconfirmed — verify on-chain');
        return;
    }
    // safeSend returned false before broadcasting (presim or send rejected).
    await d.store.markFailed(campaign, drawingId, position, 'presim or send rejected — see fail channel');
}

async function buildDeps(config: ExecutorConfig, prizerail: PrizerailConfig, walletManager: WalletManager): Promise<PayoutDeps> {
    const signer = walletManager.getSigner(WalletRole.Prize);
    const provider = signer.provider!;
    const chainId = Number((await withTimeout(provider.getNetwork(), 10_000)).chainId);
    if (chainId !== prizerail.chainId) {
        throw new Error(
            `prizerail-payout: the ${prizerail.site} site pays on chain ${prizerail.chainId} but the RPC is chain ${chainId} — refusing to start (sandbox key ↔ Base Sepolia, prod key ↔ Base mainnet)`,
        );
    }
    const usdcAddress = resolveUsdcAddress(chainId);
    const usdc = new Contract(usdcAddress, ERC20_ABI, signer);
    const prizeAddress = await signer.getAddress();

    const decimals = Number(await withTimeout(usdc.decimals(), 10_000));
    if (decimals !== USDC_DECIMALS) {
        throw new Error(`USDC ${usdcAddress} on chain ${chainId} reports ${decimals} decimals, expected ${USDC_DECIMALS} — refusing to pay`);
    }
    logger.info(`prizerail-payout: chain ${chainId}, USDC ${usdcAddress}`);

    return {
        dryRun: config.dryRun,
        campaign: prizerail.campaignSlug,
        prizeAddress,
        minBalance: parseUnits(String(PRIZERAIL_POLICY.prizeWalletMinUsdc), USDC_DECIMALS),
        store: getPrizerailStore(config),
        balanceOf: (a) => withTimeout(usdc.balanceOf(a), 10_000),
        minedNonce: (a) => withTimeout(provider.getTransactionCount(a, 'latest'), 10_000),
        receiptStatus: async (hash) => {
            const r = await withTimeout(provider.getTransactionReceipt(hash), 10_000);
            return r ? ((r.status === 1 ? 1 : 0) as 0 | 1) : null;
        },
        transfer: (to, amount, onSent) =>
            safeSend(usdc, 'transfer', [to, amount], config, { prizerail: 'payout', to, usdc: usdcLabel(amount) }, false, { onSent }),
        alertSuccess: (m) => sendOnSuccess(config, m),
        alertFail: (m) => sendOnFail(config, m),
        alertBalance: (m) => sendBalanceAlert(config, m),
        now: () => Date.now(),
        balanceAlert: { lastAt: 0 },
    };
}

/**
 * Pays winners from the dedicated prize wallet. One consumer (concurrency 1)
 * so the wallet's NonceManager has a single writer — run ONE replica. At-
 * most-once per winner: the ledger row is claimed before sending, the mined
 * nonce and then the tx hash are persisted before waiting, and any retry
 * reconciles from the chain instead of sending again. DRY_RUN pays nothing.
 */
export async function startPrizerailPayoutWorker(config: ExecutorConfig, walletManager: WalletManager): Promise<void> {
    const prizerail = config.prizerail;
    if (!prizerail || !prizerail.payoutEnabled) {
        logger.info('prizerail-payout: off (set PRIZE_PAYOUT_EXECUTOR to enable) — worker not started');
        return;
    }

    initPrizerailPayoutQueue();
    // A chain mismatch or slow RPC must not take down core jobs: skip payouts
    // for this run. Winners stay 'pending' in the ledger and are paid once a
    // restart starts the worker.
    let deps: PayoutDeps;
    try {
        deps = await buildDeps(config, prizerail, walletManager);
    } catch (err: unknown) {
        const msg = `prizerail-payout: NOT started (${(err as Error)?.message ?? err}) — entries and winner discovery keep running; payouts resume after a restart`;
        logger.error(msg);
        await sendOnFail(config, `⚠️ ${msg}`).catch(() => {});
        return;
    }

    const worker = new Worker<PrizerailPayoutJobData>(
        PRIZERAIL_PAYOUT_QUEUE_NAME,
        async (job) => {
            if (job.name !== PRIZERAIL_PAYOUT_JOB_NAME) {
                logger.warn(`prizerail-payout: unexpected job ${job.name}`);
                return;
            }
            await payWinner(deps, job.data);
        },
        { connection, concurrency: 1, lockDuration: LOCK_DURATION_MS },
    );

    worker.on('error', (err) => logger.error(`prizerail-payout: worker error: ${err?.message}`));
    worker.on('failed', (job, err) => {
        const msg = `prizerail-payout: failed jobId=${job?.id} attempt=${job?.attemptsMade}/${job?.opts.attempts ?? 1}: ${err?.message}`;
        logger.warn(msg);
        if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
            void sendOnFail(config, `Prizerail payout gave up for now — the scanner re-queues it next tick\n${msg}`).catch(() => {});
        }
    });

    logger.info(
        `prizerail-payout: started (prize wallet ${deps.prizeAddress}, cap ${PRIZERAIL_POLICY.maxAutoPayoutCents}c, dryRun=${config.dryRun})`,
    );
}
