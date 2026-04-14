import { Contract, Wallet, NonceManager } from 'ethers';
import { logger } from './logger';
import { sendOnFail, sendOnSuccess } from './alerts';
import { ContractCallerConfig } from './config';

// Alert formatting helpers

/** Strip ethers v6's massive parenthetical detail blob from error messages */
function fmtErr(err: any): string {
    const reason = err?.reason ?? err?.error?.reason ?? null;
    if (reason) return String(reason);
    // Custom error: include the 4-byte selector so it can be decoded manually
    const data = err?.data ?? err?.error?.data ?? null;
    if (data && typeof data === 'string' && data.length >= 10) {
        const selector = data.slice(0, 10); // 0x + 4 bytes
        const msg = String(err?.message ?? err).replace(/\s*\(action=.*$/s, '').trim().slice(0, 150);
        return `${msg} [selector: ${selector}]`;
    }
    const msg = String(err?.message ?? err);
    return msg.replace(/\s*\(action=.*$/s, '').trim().slice(0, 200);
}

/** Format meta object as clean key=value pairs, truncating addresses */
function fmtMeta(meta: Record<string, any>): string {
    return Object.entries(meta)
        .map(([k, v]) => {
            if (!Array.isArray(v)) return `${k}=${v}`;
            const isAddrs = typeof v[0] === 'string' && v[0].startsWith('0x') && v[0].length === 42;
            return isAddrs
                ? `${k}=${v.map((a: string) => `[${a}](https://basescan.org/address/${a})`).join(', ')}`
                : `${k}=${v.join(',')}`;
        })
        .join(' | ');
}

/** Shorten a tx hash and link to basescan */
function fmtHash(hash: string): string {
    return `[${hash.slice(0, 10)}...${hash.slice(-6)}](https://basescan.org/tx/${hash})`;
}

// ─────────────────────────────────────────────────────────────────────────────

export async function safeSend(
    contract: Contract,
    fnName: string,
    args: any[],
    config: ContractCallerConfig,
    meta: Record<string, any> = {},
    skipPresim = false,
): Promise<boolean> {
    const isDryRun = config.dryRun;
    const signer = contract.runner as Wallet | NonceManager | undefined;
    const m = fmtMeta(meta);

    try {
        if (!signer || !(signer as any).provider) {
            const msg = `${fnName} | missing signer/provider | ${m}`;
            logger.error(msg);
            await sendOnFail(config, msg);
            throw new Error('missing signer/provider');
        }

        const fn = (contract as any)[fnName];

        // DRY RUN MODE: simulate only, no real tx
        if (isDryRun) {
            logger.debug('RUNNING DRY RUN');
            try {
                const res = await fn.staticCall(...args);
                logger.info(`safeSend[DRY_RUN]: simulated fn=${fnName} ok meta=${JSON.stringify(meta)}`);
                logger.debug(`res: ${JSON.stringify(res)}`);
                return true;
            } catch (err: any) {
                logger.error(`safeSend[DRY_RUN]: simulation failed fn=${fnName}: ${fmtErr(err)}`);
                return false;
            }
        }

        // REAL TX MODE: optional pre-simulation (skipped for functions guarded on-chain)
        if (!skipPresim) {
            try {
                await fn.staticCall(...args);
            } catch (err: any) {
                const alert = `${fnName} | staticCall reverted | ${m}\n↳ ${fmtErr(err)}`;
                logger.error(`safeSend: staticCall failed fn=${fnName} meta=${JSON.stringify(meta)}: ${err.message}`);
                await sendOnFail(config, alert);
                return false;
            }
        }

        // REAL TX MODE: SEND
        let tx;
        try {
            tx = await fn(...args);
        } catch (err: any) {
            // Nonce issues: reset and retry silently — no Discord alert, these are transient
            if (err.code === 'NONCE_EXPIRED' && signer instanceof NonceManager) {
                signer.reset();
                logger.warn(`safeSend: NONCE_EXPIRED, nonce reset, will retry fn=${fnName}`);
                err._alerted = true;
                throw err; // BullMQ retries
            }
            if (err.code === 'REPLACEMENT_UNDERPRICED' && signer instanceof NonceManager) {
                signer.reset();
                logger.warn(`safeSend: REPLACEMENT_UNDERPRICED, nonce reset fn=${fnName}`);
                err._alerted = true;
                return false;
            }
            // All other send failures: alert Discord
            const alert = `${fnName} | send failed | ${m}\n↳ ${err.code ?? fmtErr(err)}`;
            logger.error(`safeSend: sendTransaction failed fn=${fnName} meta=${JSON.stringify(meta)}: ${err.message}`);
            await sendOnFail(config, alert);
            if (err.code === 'CALL_EXCEPTION') return false;
            err._alerted = true;
            throw err;
        }

        logger.info(`safeSend: tx sent fn=${fnName} hash=${tx.hash} meta=${JSON.stringify(meta)}`);

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
                if (signer instanceof NonceManager) {
                    signer.reset();
                    logger.warn(`safeSend: NonceManager reset after TX_WAIT_TIMEOUT fn=${fnName}`);
                }
                try {
                    const provider = (signer as any)?.provider ?? contract.runner?.provider ?? null;
                    const landed = provider ? await provider.getTransactionReceipt(tx.hash) : null;
                    if (landed && landed.status === 1) {
                        const alert = `${fnName} | ${m}\n↳ ${fmtHash(tx.hash)}`;
                        logger.info(`safeSend: tx confirmed post-timeout fn=${fnName} hash=${tx.hash} block=${landed.blockNumber}`);
                        await sendOnSuccess(config, alert);
                        return true;
                    } else if (landed && landed.status !== 1) {
                        logger.error(`safeSend: tx reverted post-timeout fn=${fnName} hash=${tx.hash}`);
                    } else {
                        logger.warn(`safeSend: tx still pending post-timeout fn=${fnName} hash=${tx.hash}`);
                    }
                } catch (receiptErr: any) {
                    logger.warn(`safeSend: post-timeout receipt check failed fn=${fnName}: ${receiptErr.message}`);
                }
                const alert = `${fnName} | wait timeout (tx may still be pending) | ${m}\n↳ ${fmtHash(tx.hash)}`;
                logger.error(`safeSend: tx wait timeout fn=${fnName} hash=${tx.hash} meta=${JSON.stringify(meta)}`);
                await sendOnFail(config, alert);
                return false;
            }

            // Real tx.wait error — decide whether to retry
            const code = err.code;
            const data = err.data ?? err.error?.data ?? null;
            logger.error(`safeSend: tx wait error fn=${fnName} hash=${tx.hash} meta=${JSON.stringify(meta)}: ${err.message}`);

            const hasReceipt = err.receipt != null;
            const isCallException = code === 'CALL_EXCEPTION' && data == null && !hasReceipt;
            const isNetworkError = !code || code === 'TIMEOUT' || code === 'NETWORK_ERROR' || code === 'SERVER_ERROR';
            const shouldRetry = isCallException || isNetworkError;

            const alert = shouldRetry
                ? `${fnName} | tx wait error (retrying) | ${m}\n↳ ${fmtHash(tx.hash)}`
                : `${fnName} | tx reverted | ${m}\n↳ ${fmtHash(tx.hash)}`;
            await sendOnFail(config, alert);

            if (shouldRetry) {
                err._alerted = true;
                throw err;
            }
            return false;
        }

        if (receipt.status !== 1) {
            logger.error(`safeSend: tx reverted fn=${fnName} hash=${tx.hash} status=${receipt.status} meta=${JSON.stringify(meta)}`);
            const alert = `${fnName} | tx reverted | ${m}\n↳ ${fmtHash(tx.hash)}`;
            await sendOnFail(config, alert);
            return false;
        }

        // success
        const alert = `${fnName} | ${m}\n↳ ${fmtHash(tx.hash)}`;
        logger.info(`safeSend: tx confirmed fn=${fnName} hash=${tx.hash} block=${receipt.blockNumber} meta=${JSON.stringify(meta)}`);
        await sendOnSuccess(config, alert);
        return true;

    } catch (err: any) {
        if (!err._alerted) {
            const alert = `${fnName} | error (retrying) | ${m}\n↳ ${fmtErr(err)}`;
            logger.error(`safeSend: unhandled error fn=${fnName} meta=${JSON.stringify(meta)}: ${err.message}`);
            await sendOnFail(config, alert);
        }
        throw err;
    }
}
