import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

import { timingSafeEqual } from 'crypto';
import { ethers } from 'ethers';
import { loadExecutorConfig } from './helpers/config';
import { startToggleWorker } from './queue/workers/toggleWorker';
import { startAssignWorker } from './queue/workers/assignWorker';
import { startOrderSweeperWorker } from './queue/workers/orderSweeperWorker';
import { startOrderScannerWorker } from './queue/workers/orderScannerWorker';
import { startCashbackWorker } from './queue/workers/cashbackWorker';
import { startDailyKeeperWorker } from './queue/workers/dailyKeeperWorker';
import { logger } from './helpers/logger';
import { CONTRACT_AUTOMATION_REGISTRY } from './helpers/registry';
import { getBaseHttpProvider, getFundingSigner } from './helpers/provider';
import { startListeners } from './listeners';
import { startSchedulers } from './schedulers';
import { getTrackedOrderIds, syncOrderIds } from './utils/orderTracker';
import { WalletManager } from './helpers/walletManager';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const BALANCE_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Every route except /healthz is an operator debug surface (automation registry,
 * tracked orders, RPC-backed tx inspection). They are gated behind a shared
 * secret in EXECUTOR_API_KEY, sent as `x-api-key` or `Authorization: Bearer`.
 * When the key is unset the routes are not mounted at all, so a deploy that
 * forgets to configure it exposes nothing instead of falling back to open
 * access.
 */
const API_KEY = (process.env.EXECUTOR_API_KEY ?? '').trim();

function timingSafeEqualStr(received: unknown, expected: string): boolean {
    if (typeof received !== 'string') return false;
    const a = Buffer.from(received);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
}

function requireApiKey(req: express.Request, res: express.Response, next: express.NextFunction) {
    const header = req.headers['authorization'];
    const bearer = typeof header === 'string' && header.startsWith('Bearer ')
        ? header.slice('Bearer '.length)
        : undefined;
    const presented = (req.headers['x-api-key'] as string | undefined) ?? bearer;
    if (!timingSafeEqualStr(presented, API_KEY)) {
        res.status(401).json({ error: 'unauthorized' });
        return;
    }
    next();
}

async function start() {
    const config = loadExecutorConfig();

    if (config.dryRun) {
        logger.warn('');
        logger.warn('====================================================');
        logger.warn('   DRY RUN MODE — NO TRANSACTIONS WILL BE SENT');
        logger.warn('====================================================');
        logger.warn('');
    }

    const provider = getBaseHttpProvider(config);

    // Init wallet manager — every signing key is read from the environment
    const walletManager = new WalletManager();
    await walletManager.init(provider);

    const fundingSigner = getFundingSigner(config);
    const fundingAddress = await fundingSigner.getAddress();

    // Announce startup — sends all wallet addresses to the success channel
    await walletManager.announceStartup(config.discordOnSuccessWebhookUrl, fundingAddress);

    // Balance monitor: check + auto-fund subwallets every 10 minutes (alerts → balance channel)
    const minBalanceWei = ethers.parseEther(String(config.minBaseBalanceEth));
    const runBalanceCheck = () =>
        walletManager.checkAndFund(fundingSigner, minBalanceWei, config.discordBalanceWebhookUrl, config.dryRun)
            .catch((err: any) => logger.error(`balance check error: ${err.message}`));

    await runBalanceCheck(); // check once on boot
    setInterval(runBalanceCheck, BALANCE_CHECK_INTERVAL_MS);

    // Seed pending orders to order sweeper (skip in dry-run — no point scanning 10k blocks)
    if (!config.dryRun) {
        await syncOrderIds(config, 2500);
        logger.info('initial syncOrderIds done');
    } else {
        logger.info('dry-run: skipping initial syncOrderIds');
    }

    const app = express();
    app.disable('x-powered-by');
    app.get('/healthz', (_req, res) => res.status(200).send("I'm alive"));

    if (API_KEY) {
        app.use(['/registry', '/orders', '/tx'], requireApiKey);
    } else {
        logger.warn('EXECUTOR_API_KEY unset — debug routes (/registry, /orders, /tx/:hash) are disabled; only /healthz is served');
        app.use(['/registry', '/orders', '/tx'], (_req, res) => res.status(404).end());
    }

    app.get('/registry', (_req, res) => res.json(CONTRACT_AUTOMATION_REGISTRY));

    app.get('/tx/:hash', async (req, res) => {
        const hash = req.params.hash;

        try {
            const tx = await provider.getTransaction(hash);
            const receipt = await provider.getTransactionReceipt(hash);

            if (!tx && !receipt) {
                return res.status(404).json({
                    hash,
                    error: 'tx_not_found',
                    message: 'Transaction not found on this RPC',
                });
            }

            let revertReason: string | null = null;

            if (receipt && receipt.status === 0 && tx) {
                try {
                    await provider.call({
                        to: tx.to!,
                        from: tx.from,
                        data: tx.data,
                        value: tx.value,
                    });
                } catch (err: any) {
                    revertReason =
                        err?.reason ||
                        err?.error?.message ||
                        err?.data?.message ||
                        String(err?.message ?? err);
                }
            }

            const meta = {
                pending: !!tx && !receipt,
                status: receipt?.status ?? null,
                blockNumber: receipt?.blockNumber ?? null,
                gasUsed: receipt?.gasUsed ? receipt.gasUsed.toString() : null,
                effectiveGasPrice: (receipt as any)?.effectiveGasPrice
                    ? (receipt as any).effectiveGasPrice.toString()
                    : null,
                from: tx?.from ?? null,
                to: tx?.to ?? null,
                nonce: tx?.nonce ?? null,
                value: tx?.value ? tx.value.toString() : null,
            };

            return res.json({ hash, tx, receipt, meta, revertReason });
        } catch (err: any) {
            logger.error(`debug tx error for hash= ${hash} ${String(err?.message ?? err)}`);
            return res.status(500).json({
                hash,
                error: 'debug_tx_error',
                message: String(err?.message ?? err),
            });
        }
    });

    app.get('/orders', async (_req, res) => {
        const orders = await getTrackedOrderIds();
        res.json({ orders });
    });

    app.listen(PORT, () => logger.info(`http server listening on port: ${PORT}`));

    // WS listener
    await startListeners(config);
    logger.info('listeners started');

    await startSchedulers();
    logger.info('schedulers started');

    // Workers
    startToggleWorker(config, walletManager);
    startAssignWorker(config, walletManager);
    // startToggleScheduleWorker(config, walletManager); // disabled — enable when needed
    startOrderSweeperWorker(config, walletManager);
    startOrderScannerWorker(config);
    startCashbackWorker(config, walletManager); // no-op when programme env unset
    startDailyKeeperWorker(config, walletManager);
    logger.info('workers started');
}

start().catch((err) => {
    console.error('startup error', String(err));
    process.exit(1);
});
