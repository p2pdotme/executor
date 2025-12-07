import { Contract, Wallet } from 'ethers';
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
    const isDryRun = false; // for TESTING update to true
    const signer = contract.runner as Wallet | undefined;

    try {
        if (!signer || !signer.provider) {
            const msg = `safeSend: missing signer/provider for fn= ${fnName} meta= ${JSON.stringify(meta)}`;
            logger.error(msg);
            await sendOnFail(config, msg);
            throw new Error('missing signer/provider');
        }

        // balance check (just warns + alerts, does not block)
        await ensureSufficientBalance(config, signer);

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
            // send failing can be transient (RPC, network) -> allow retries
            throw err;
        }

        logger.info(
            `safeSend: tx sent fn= ${fnName} hash= ${tx.hash} meta= ${JSON.stringify(meta)}`,
        );

        // WAIT FOR 1 CONFIRMATION
        try {
            const receipt = await tx.wait(1);

            if (receipt.status !== 1) {
                const msg =
                    `❌ safeSend: tx reverted fn= ${fnName} hash= ${tx.hash} ` +
                    `status= ${receipt.status} meta= ${JSON.stringify(meta)}`;
                logger.error(msg);

                // usually deterministic revert here -> alert but don't retry
                const alert = `❌ ${fnName} onFail: tx reverted for ${JSON.stringify(
                    meta,
                )} with hash ${tx.hash}`;
                await sendOnFail(config, alert);

                return false;
            }

            // success path
            const alert = `✅ ${fnName} onSuccess: tx confirmed for ${JSON.stringify(
                meta,
            )} with hash ${tx.hash}`;
            logger.info(
                `✅ safeSend: tx confirmed fn= ${fnName} hash= ${tx.hash} block= ${receipt.blockNumber
                } meta= ${JSON.stringify(meta)}`,
            );
            await sendTelegramMessage(
                config.onFailBotToken,
                config.onFailChanneld,
                config.onFailTopicId,
                alert,
            );

            return true;
        } catch (err: any) {
            const code = err.code;
            const data = err.data ?? err.error?.data ?? null;

            const baseMsg =
                `❌ safeSend: tx wait error fn= ${fnName} hash= ${tx.hash} ` +
                `meta= ${JSON.stringify(meta)}: ${err.message}`;
            logger.error(baseMsg);

            // if CALL_EXCEPTION && data=null -> retry
            const isCallException = code === 'CALL_EXCEPTION';
            const hasNullData = data == null;

            const shouldRetry = isCallException && hasNullData;

            const alert = shouldRetry
                ? `❌ ${fnName} onFail: tx wait error (will retry if attempts remain) for ${JSON.stringify(
                    meta,
                )} with hash ${tx.hash}: ${err.message}`
                : `❌ ${fnName} onFail: tx wait error (no retry) for ${JSON.stringify(
                    meta,
                )} with hash ${tx.hash}: ${err.message}`;

            await sendOnFail(config, alert);

            if (shouldRetry) {
                // throw so BullMQ counts this as a failure and retries
                throw err;
            }

            // non-retryable wait error -> just return false
            return false;
        }
    } catch (err: any) {
        const msg = `❌ safeSend ERROR fn= ${fnName} meta= ${JSON.stringify(
            meta,
        )} err= ${err.message} "will retry"`;
        logger.error(msg);
        await sendOnFail(config, msg);
        // this throw, allows BullMQ to retry
        throw err;
    }
}
