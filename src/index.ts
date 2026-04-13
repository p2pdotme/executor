import express from 'express';
import dotenv from 'dotenv';
dotenv.config();

import { ethers } from 'ethers';
import { loadExecutorConfig } from './helpers/config';
import { startToggleWorker } from './queue/workers/toggleWorker';
import { startAssignWorker } from './queue/workers/assignWorker';
import { startOrderSweeperWorker } from './queue/workers/orderSweeperWorker';
import { startOrderScannerWorker } from './queue/workers/orderScannerWorker';
import { logger } from './helpers/logger';
import { CONTRACT_AUTOMATION_REGISTRY } from './helpers/registry';
import { getBaseHttpProvider, getFundingSigner } from './helpers/provider';
import { startListeners } from './listeners';
import { startSchedulers } from './schedulers';
import { getTrackedOrderIds, syncOrderIds } from './utils/orderTracker';
import { WalletManager } from './helpers/walletManager';
import { connection } from './queue';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;
const BALANCE_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

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

    // Init wallet manager — generates subwallets on first boot, loads from Redis on restart
    const walletManager = new WalletManager();
    await walletManager.init(provider, connection);

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
        await syncOrderIds(config, 10000);
        logger.info('initial syncOrderIds done');
    } else {
        logger.info('dry-run: skipping initial syncOrderIds');
    }

    const app = express();
    app.get('/healthz', (_req, res) => res.status(200).send("I'm alive"));
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
    logger.info('workers started');
}

start().catch((err) => {
    console.error('startup error', String(err));
    process.exit(1);
});
