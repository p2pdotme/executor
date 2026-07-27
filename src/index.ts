import dotenv from 'dotenv';
dotenv.config();

import { createServer } from 'http';
import { ethers } from 'ethers';
import { loadExecutorConfig } from './helpers/config';
import { startToggleWorker } from './queue/workers/toggleWorker';
import { startAssignWorker } from './queue/workers/assignWorker';
import { startOrderSweeperWorker } from './queue/workers/orderSweeperWorker';
import { startOrderScannerWorker } from './queue/workers/orderScannerWorker';
import { startCashbackWorker } from './queue/workers/cashbackWorker';
import { startDailyKeeperWorker } from './queue/workers/dailyKeeperWorker';
import { logger } from './helpers/logger';
import { getBaseHttpProvider, getFundingSigner } from './helpers/provider';
import { startListeners } from './listeners';
import { startSchedulers } from './schedulers';
import { syncOrderIds } from './utils/orderTracker';
import { WalletManager } from './helpers/walletManager';

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

    // The executor is a worker, not an API. The only thing it serves is the
    // liveness probe the deploy platform needs; everything an operator might
    // want to inspect is already in the logs, on Basescan, or in Redis.
    createServer((req, res) => {
        if (req.method === 'GET' && req.url === '/healthz') {
            res.writeHead(200, { 'content-type': 'text/plain' });
            res.end("I'm alive");
            return;
        }
        res.writeHead(404).end();
    }).listen(PORT, () => logger.info(`healthz server listening on port: ${PORT}`));

    // WS listener
    await startListeners(config);
    logger.info('listeners started');

    await startSchedulers();
    logger.info('schedulers started');

    // Workers
    startToggleWorker(config, walletManager);
    startAssignWorker(config, walletManager);
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
