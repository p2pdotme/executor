import { Worker } from 'bullmq';
import { Contract } from 'ethers';
import { ExecutorConfig } from '../../helpers/config';
import { logger } from '../../helpers/logger';
import { handlers, HandlerContext } from '../handlers';
import { ContractJobName, ContractJobData } from '../types';
import { initCashbackQueue, connection, CASHBACK_QUEUE_NAME } from '../index';
import { DIAMOND_ABI } from '../../helpers/abi';
import { CASHBACK_INTEGRATOR_ABI } from '../../helpers/cashbackIntegratorAbi';
import { sendOnFail } from '../../helpers/alerts';
import { WalletManager, WalletRole } from '../../helpers/walletManager';

const LOCK_DURATION_MS = 60_000; // 1 min — issueCredit is a tiny tx

export function startCashbackWorker(config: ExecutorConfig, walletManager: WalletManager) {
    // Programme is opt-in via env (CASHBACK_INTEGRATOR_ADDRESS + CASHBACK_BPS).
    // When either is unset the listener never enqueues, but we still guard
    // here so a stale job in Redis can't fire a write against address(0).
    if (!config.cashbackIntegratorAddress || config.cashbackBps === 0) {
        logger.info(
            'cashback-worker: programme disabled (CASHBACK_INTEGRATOR_ADDRESS / CASHBACK_BPS unset) — worker not started',
        );
        return;
    }

    const signer = walletManager.getSigner(WalletRole.Cashback);
    const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, signer);
    const cashbackIntegrator = new Contract(
        config.cashbackIntegratorAddress,
        CASHBACK_INTEGRATOR_ABI,
        signer,
    );

    initCashbackQueue();

    const ctx: HandlerContext = { config, diamond, cashbackIntegrator };

    const worker = new Worker<ContractJobData>(
        CASHBACK_QUEUE_NAME,
        async (job) => {
            const name = job.name as ContractJobName;

            if (name !== 'IssueCashbackCredit') {
                const msg = `cashback-worker: unexpected job ${name} jobId= ${job.id}`;
                logger.warn(msg);
                await sendOnFail(config, msg);
                return;
            }

            const handler = handlers[name];
            if (!handler) {
                const msg = `cashback-worker: no handler for job ${name}`;
                logger.error(msg);
                await sendOnFail(config, msg);
                return;
            }

            logger.info(`▶️ cashback-worker: job start ${name} jobId= ${job.id}`);

            try {
                const ok = await handler(job.data, ctx);
                if (!ok) {
                    logger.warn(`cashback-worker: handler returned false for job ${name} jobId= ${job.id}`);
                } else {
                    logger.info(`✅ cashback-worker: job ok ${name} jobId= ${job.id}`);
                }
            } catch (err: any) {
                const reason = err?.stack ?? err?.message ?? String(err);
                logger.error(`cashback-worker error job=${name} jobId=${job.id}: ${reason}`);
                if (!(err as any)._alerted) {
                    await sendOnFail(
                        config,
                        `Cashback worker error\nJob= ${name}\nJobId= ${job.id}\n↳ ${err?.message ?? String(err)}`,
                    );
                }
                throw err;
            }
        },
        {
            connection,
            concurrency: 1, // serialize so the cashback wallet's nonce manager stays sane
            lockDuration: LOCK_DURATION_MS,
        },
    );

    worker.on('error', (err) =>
        logger.error(`❌ cashback-worker: Worker error: ${err?.message}`),
    );

    worker.on('completed', (job) =>
        logger.info(`✅ cashback-worker: completed jobId= ${job.id} ${job.name}`),
    );

    worker.on('failed', (job, err) =>
        logger.warn(`❌ cashback-worker: failed jobId= ${job?.id} ${job?.name}: ${err?.message}`),
    );

    logger.info(`▶️ cashback-worker: started (integrator=${config.cashbackIntegratorAddress} bps=${config.cashbackBps})`);
}
