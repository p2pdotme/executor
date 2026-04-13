import { Contract, Wallet, NonceManager } from 'ethers';
import { logger } from './logger';
import { ensureSufficientBalance, sendOnFail, sendTelegramMessage } from './alerts';
import { ContractCallerConfig } from './config';

export async function safeSend(
    contract: Contract,
    fnName: string,
    args: any[],
    config: ContractCallerConfig,
    meta: Record<string, any> = {},
): Promise<boolean> {
    const isDryRun = config.dryRun;
    const signer = contract.runner as Wallet | NonceManager | undefined;

    try {
        if (!signer || !(signer as any).provider) {
            const msg = `safeSend: missing signer/provider for fn= ${fnName} meta= ${JSON.stringify(meta)}`;
            logger.error(msg);
            await sendOnFail(config, msg);
            throw new Error('missing signer/provider');
        }

        // balance check (just warns + alerts, does not block)
        if (!isDryRun) await ensureSufficientBalance(config, signer);

        const fn = (contract as any)[fnName];
        // DRY RUN MODE
        if (isDryRun) {
            logger.debug('RUNNING DRY RUN');
            try {
                const res = await fn.staticCall(...args);

                logger.info(
                    `safeSend[DRY_RUN]: simulated fn= ${fnName} ok meta= ${JSON.stringify(meta)}`,
                );
                logger.debug(`res: ${JSON.stringify(res)}`);
                return true;
            } catch (err: any) {
                const msg = `❌ safeSend[DRY_RUN]: simulation failed fn= ${fnName} meta= ${JSON.stringify(
                    meta,
                )}: ${err.message}`;
                logger.error(msg);
                // no tx, just return
                return false;
            }
        }

        // REAL TX MODE: PRE-STATIC CALL
        try {
            await fn.staticCall(...args);
        } catch (err: any) {
            const msg = `❌ safeSend: staticCall failed BEFORE write fn= ${fnName} meta= ${JSON.stringify(meta)}: ${err.message} (static call failed before write call; need to debug)`;
            logger.error(msg);
            await sendOnFail(config, msg);
            // don't send the real tx if simulation fails
            return false;
        }

        // REAL TX MODE: SEND
        let tx;
        try {
            tx = await fn(...args); // ethers auto-estimates gas + fees
        } catch (err: any) {
            const msg = `❌ safeSend: sendTransaction failed fn= ${fnName} meta= ${JSON.stringify(meta)}: ${err.message}`;
            logger.error(msg);
            await sendOnFail(config, msg);
            // CALL_EXCEPTION during estimateGas = deterministic contract revert, no point retrying
            if (err.code === 'CALL_EXCEPTION') return false;
            // NONCE_EXPIRED = NonceManager cached a stale nonce, reset so next attempt re-fetches from chain
            if (err.code === 'NONCE_EXPIRED' && signer instanceof NonceManager) {
                signer.reset();
                logger.warn(`safeSend: NonceManager reset after NONCE_EXPIRED fn= ${fnName}`);
            }
            // REPLACEMENT_UNDERPRICED = a tx with this nonce is already stuck in the mempool.
            // Retrying with the same or lower gas just loops forever and blocks all subsequent jobs.
            // Reset the NonceManager so the next job gets a fresh nonce and can proceed.
            if (err.code === 'REPLACEMENT_UNDERPRICED' && signer instanceof NonceManager) {
                signer.reset();
                logger.warn(`safeSend: NonceManager reset after REPLACEMENT_UNDERPRICED fn= ${fnName} — stuck mempool tx, skipping retry`);
                err._alerted = true;
                return false;
            }
            // mark as already alerted so outer catch skips duplicate sendOnFail
            err._alerted = true;
            throw err;
        }

        logger.info(
            `safeSend: tx sent fn= ${fnName} hash= ${tx.hash} meta= ${JSON.stringify(meta)}`,
        );

        // WAIT FOR 1 CONFIRMATION — 3 min timeout to unblock the concurrency slot.
        // On timeout: alert + return false. Never throw — tx is already broadcast;
        // throwing lets BullMQ retry -> duplicate tx.
        const TX_WAIT_TIMEOUT_MS = 3 * 60_000;
        let waitTimeoutId: NodeJS.Timeout | undefined;
        let receipt: any;
        try {
            const timeoutPromise = new Promise<never>((_, reject) => {
                waitTimeoutId = setTimeout(() => {
                    reject(Object.assign(new Error('tx.wait timed out'), { code: 'TX_WAIT_TIMEOUT' }));
                }, TX_WAIT_TIMEOUT_MS);
            });
            receipt = await Promise.race([tx.wait(1), timeoutPromise]);
            clearTimeout(waitTimeoutId);
        } catch (err: any) {
            clearTimeout(waitTimeoutId);
            if (err.code === 'TX_WAIT_TIMEOUT') {
                // Reset NonceManager so the next job gets a fresh nonce from chain,
                // not a stale cached value from this timed-out tx.
                if (signer instanceof NonceManager) {
                    signer.reset();
                    logger.warn(`safeSend: NonceManager reset after TX_WAIT_TIMEOUT fn= ${fnName}`);
                }

                // Tx is broadcast but wait timed out — check if it actually landed.
                // Do NOT throw: BullMQ would retry -> duplicate tx.
                try {
                    const provider = (signer as any)?.provider ?? contract.runner?.provider ?? null;
                    const landed = provider ? await provider.getTransactionReceipt(tx.hash) : null;
                    if (landed && landed.status === 1) {
                        const alert = `✅ ${fnName} onSuccess (post-timeout): tx confirmed for ${JSON.stringify(meta)} with hash ${tx.hash}`;
                        logger.info(`✅ safeSend: tx confirmed post-timeout fn= ${fnName} hash= ${tx.hash} block= ${landed.blockNumber} meta= ${JSON.stringify(meta)}`);
                        await sendTelegramMessage(config.onFailBotToken, config.onFailChanneld, config.onSuccessTopicId, alert);
                        return true;
                    } else if (landed && landed.status !== 1) {
                        logger.error(`❌ safeSend: tx reverted post-timeout fn= ${fnName} hash= ${tx.hash}`);
                    } else {
                        logger.warn(`⚠️ safeSend: tx still pending post-timeout fn= ${fnName} hash= ${tx.hash}`);
                    }
                } catch (receiptErr: any) {
                    logger.warn(`safeSend: post-timeout receipt check failed fn= ${fnName}: ${receiptErr.message}`);
                }
                const msg = `⚠️ safeSend: tx wait timeout fn= ${fnName} hash= ${tx.hash} (tx may still be pending) meta= ${JSON.stringify(meta)}`;
                logger.error(msg);
                await sendOnFail(config, msg);
                return false;
            }

            // Real tx.wait error — decide whether to retry
            const code = err.code;
            const data = err.data ?? err.error?.data ?? null;
            const baseMsg = `❌ safeSend: tx wait error fn= ${fnName} hash= ${tx.hash} meta= ${JSON.stringify(meta)}: ${err.message}`;
            logger.error(baseMsg);

            // Retry: CALL_EXCEPTION with no data + no receipt (RPC glitch, tx still pending)
            //        or any network/timeout error
            // No retry: receipt present -> tx mined and reverted on-chain (deterministic)
            const hasReceipt = err.receipt != null;
            const isCallException = code === 'CALL_EXCEPTION' && data == null && !hasReceipt;
            const isNetworkError = !code || code === 'TIMEOUT' || code === 'NETWORK_ERROR' || code === 'SERVER_ERROR';
            const shouldRetry = isCallException || isNetworkError;

            const alert = shouldRetry
                ? `❌ ${fnName} onFail: tx wait error (will retry if attempts remain) for ${JSON.stringify(meta)} with hash ${tx.hash}: ${err.message}`
                : `❌ ${fnName} onFail: tx wait error (no retry) for ${JSON.stringify(meta)} with hash ${tx.hash}: ${err.message}`;
            await sendOnFail(config, alert);

            if (shouldRetry) {
                err._alerted = true;
                throw err;
            }
            return false;
        }

        if (receipt.status !== 1) {
            const msg =
                `❌ safeSend: tx reverted fn= ${fnName} hash= ${tx.hash} ` +
                `status= ${receipt.status} meta= ${JSON.stringify(meta)}`;
            logger.error(msg);
            const alert = `❌ ${fnName} onFail: tx reverted for ${JSON.stringify(meta)} with hash ${tx.hash}`;
            await sendOnFail(config, alert);
            return false;
        }

        // success
        const alert = `✅ ${fnName} onSuccess: tx confirmed for ${JSON.stringify(meta)} with hash ${tx.hash}`;
        logger.info(`✅ safeSend: tx confirmed fn= ${fnName} hash= ${tx.hash} block= ${receipt.blockNumber} meta= ${JSON.stringify(meta)}`);
        await sendTelegramMessage(
            config.onFailBotToken,
            config.onFailChanneld,
            config.onSuccessTopicId,
            alert,
        );
        return true;
    } catch (err: any) {
        // Only alert here for errors not already handled by an inner catch
        if (!err._alerted) {
            const msg = `❌ safeSend ERROR fn= ${fnName} meta= ${JSON.stringify(meta)} err= ${err.message} "will retry"`;
            logger.error(msg);
            await sendOnFail(config, msg);
        }
        throw err;
    }
}
