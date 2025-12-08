import express from 'express';
import dotenv, { config } from 'dotenv';
dotenv.config();

import { loadCommonConfig, loadAssignConfig, loadOrderSweeperConfig, loadToggleConfig, loadToggleScheduleConfig } from './helpers/config';
import { startToggleWorker } from './queue/workers/toggleWorker';
import { startAssignWorker } from './queue/workers/assignWorker';
import { startToggleScheduleWorker } from './queue/workers/toggleScheduleWorker';
import { startOrderSweeperWorker } from './queue/workers/orderSweeperWorker';
import { startOrderScannerWorker } from './queue/workers/orderScannerWorker';
import { logger } from './helpers/logger';
import { CONTRACT_AUTOMATION_REGISTRY } from './helpers/registry';
import { getBaseHttpProvider } from './helpers/provider';
import { startListeners } from './listeners';
import { startSchedulers } from './schedulers';
import { getTrackedOrderIds, syncOrderIds } from './utils/orderTracker';

const PORT = process.env.PORT ? Number(process.env.PORT) : 8000;

async function start() {
    const commonConfig = loadCommonConfig();
    const toggleConfig = loadToggleConfig();
    const assignConfig = loadAssignConfig();
    const toggleScheduleConfig = loadToggleScheduleConfig();
    const orderSweeperConfig = loadOrderSweeperConfig();

    // seed pending orders to order sweeper
    await syncOrderIds(commonConfig, 1000); // last 1000 blocks
    logger.info('initial syncOrderIds done');
    logger.info('🔍 order-sweeper: pending orders seeded');

    const app = express();
    app.get('/healthz', (_req, res) => res.status(200).send("I'm alive"));
    app.get('/registry', (_req, res) => res.json(CONTRACT_AUTOMATION_REGISTRY));

    app.get('/tx/:hash', async (req, res) => {
        const hash = req.params.hash;
    
        try {
            const provider = getBaseHttpProvider(commonConfig);
    
            const tx = await provider.getTransaction(hash);
            const receipt = await provider.getTransactionReceipt(hash);
    
            // not seen by node at all
            if (!tx && !receipt) {
                return res.status(404).json({
                    hash,
                    error: 'tx_not_found',
                    message: 'Transaction not found on this RPC',
                });
            }
    
            // try to extract revert reason if failed
            let revertReason: string | null = null;
    
            if (receipt && receipt.status === 0 && tx) {
                try {
                    // re-simulate the tx to get a revert reason (latest state)
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
    
            return res.json({
                hash,
                tx,
                receipt,
                meta,
                revertReason,
            });
        } catch (err: any) {
            logger.error(
                `debug tx error for hash= ${hash} ${String(err?.message ?? err)}`,
            );
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

    // ws listener
    startListeners({ ...toggleConfig, ...assignConfig });
    logger.info('listeners started');

    startSchedulers();
    logger.info('schedulers started');

    // workers
    startToggleWorker(toggleConfig);
    startAssignWorker(assignConfig);
    startToggleScheduleWorker(toggleScheduleConfig);
    startOrderSweeperWorker(orderSweeperConfig);
    startOrderScannerWorker(commonConfig);
    logger.info('workers started');
}

start().catch((err) => {
    console.error('startup error', String(err));
    process.exit(1);
});
