import { Contract, decodeBytes32String } from 'ethers';
import { ExecutorConfig } from '../helpers/config';
import { getBaseWsProvider, getBaseHttpProvider, withTimeout } from '../helpers/provider';
import { DIAMOND_ABI } from '../helpers/abi';
import { logger } from '../helpers/logger';
import { addCashbackJob } from '../queue';
import { sendDiscordAlert } from '../helpers/discord';

const ORDER_COMPLETED_EVENT = 'OrderCompleted';

// OrderProcessorStorage.OrderType enum: { BUY=0, SELL=1, PAY=2 }
const ORDER_TYPE_BUY = 0;
const ORDER_TYPE_SELL = 1;
const BPS_DENOMINATOR = 10_000n;

// Gap-reconcile tuning. On WS reconnect we replay OrderCompleted logs that
// were emitted while the socket was down via HTTP eth_getLogs. Chunk size
// matches the proven order-scanner lookback (syncOrderIds uses a 2500-block
// getLogs). The cap keeps the reconnect scan bounded — a longer gap than this
// is treated as an outage the operator handles, not something we self-heal by
// scanning the whole chain. Re-issue is safe regardless: the cashback jobId is
// the orderId, so replaying an already-credited block never double-counts.
const RECONCILE_CHUNK_BLOCKS = 2_500;
const MAX_BACKFILL_BLOCKS = 5_000;

// Decode the order's bytes32 currency into its symbol (e.g. "ARS"). Returns
// '' when the field is empty/unset or not a valid bytes32 string so callers
// can safely fall back to the default cashback rate.
function decodeCurrency(currency: unknown): string {
    if (typeof currency !== 'string' || !currency) return '';
    try {
        return decodeBytes32String(currency).trim().toUpperCase();
    } catch {
        return '';
    }
}

// Resolve the cashback bps for an order: a per-currency override when one is
// configured for the order's currency, otherwise the default cashbackBps.
function resolveCashbackBps(config: ExecutorConfig, currencyCode: string): number {
    if (currencyCode && currencyCode in config.cashbackBpsByCurrency) {
        return config.cashbackBpsByCurrency[currencyCode];
    }
    return config.cashbackBps;
}

/**
 * B2B cashback programme listener — server-side mirror of the
 * contracts-v4 handleLotpotBuyerCashback hook that used to live inside
 * Diamond.completeOrder. Each filtered OrderCompleted event enqueues
 * one IssueCashbackCredit job; the cashback worker turns that into an
 * `integrator.issueCredit(user, amount)` write signed by the whitelisted
 * cashback wallet.
 *
 * Filtering matches the original contract hook, extended to also credit
 * SELL completions to the seller (`_order.user`):
 *   - orderType == BUY or SELL (PAY is excluded)
 *   - non-B2B (Diamond.getOrderIntegrator(orderId) == address(0))
 *   - amount > 0 after applying bps
 *
 * Programme is opt-in: when CASHBACK_INTEGRATOR_ADDRESS or CASHBACK_BPS
 * is unset, this listener silently no-ops on every event (we still
 * subscribe, so toggling the env on later doesn't need a restart).
 *
 * Idempotency: the cashback queue's jobId is the orderId, so a WS
 * reconnect that replays a recent block won't double-issue credit.
 *
 * Gap recovery: a bare `setTimeout(setup)` reconnect used to silently
 * drop every OrderCompleted event emitted while the socket was down —
 * those credits were never issued (jobId only guards against double
 * issue on replay, not against a missed issue during downtime). On each
 * reconnect we now replay the missed blocks via HTTP eth_getLogs
 * (reconcileGap) so downtime no longer means permanently missed cashback.
 */
export async function attachOrderCompletedListener(config: ExecutorConfig) {
    let reconnectScheduled = false;

    // Cross-reconnect state: the HTTP provider used for gap backfill and the
    // integrator lookup, and the highest block whose OrderCompleted logs we've
    // already processed. Baselined to chain head on first connect (we don't
    // replay history before startup) and advanced by both live and backfilled
    // logs thereafter.
    const httpProvider = getBaseHttpProvider(config);
    const httpDiamond = new Contract(config.diamondAddress, DIAMOND_ABI, httpProvider);
    const orderCompletedTopic = httpDiamond.interface.getEvent(
        ORDER_COMPLETED_EVENT,
    )!.topicHash;
    let lastProcessedBlock = 0;
    let isFirstConnect = true;

    // Programme is on when an integrator is configured AND at least one
    // positive rate exists — either the default bps or a per-currency
    // override (an operator may zero the default but still credit ARS).
    const anyCurrencyOverridePositive = Object.values(
        config.cashbackBpsByCurrency,
    ).some((bps) => bps > 0);
    const programmeOn =
        !!config.cashbackIntegratorAddress &&
        (config.cashbackBps > 0 || anyCurrencyOverridePositive);
    if (!programmeOn) {
        logger.info(
            'OrderCompleted: cashback programme disabled (env unset) — listener attached as no-op so toggling env later does not require restart',
        );
    }

    const overridesSummary = Object.entries(config.cashbackBpsByCurrency)
        .map(([code, bps]) => `${code}:${bps}`)
        .join(', ');

    // Parse → filter → enqueue for a single raw OrderCompleted log. Shared by
    // the live WS subscription and the reconnect backfill so both paths apply
    // the identical eligibility rules. Advances lastProcessedBlock so the next
    // reconcile knows where the gap starts.
    const processLog = async (
        evtLog: {
            topics: readonly string[];
            data: string;
            transactionHash?: string;
            blockNumber?: number;
        },
        source: 'live' | 'backfill',
    ) => {
        try {
            if (!programmeOn) return;
            if (!evtLog || !evtLog.topics || evtLog.data === undefined) return;
            if (typeof evtLog.blockNumber === 'number' && evtLog.blockNumber > lastProcessedBlock) {
                lastProcessedBlock = evtLog.blockNumber;
            }

            // Parse the raw log via the contract's ABI rather than trusting
            // positional handler args. Mirrors the parseLog pattern already
            // used in listeners/utils.ts.
            //
            // Subtle: the indexed `user` topic on this event is msg.sender of
            // completeOrder() — the MERCHANT, not the counterparty we want to
            // credit. The buyer (for BUY) or the seller (for SELL) lives on
            // the order tuple as `_order.user`. We pull from there so cashback
            // credits the right address.
            const parsed = httpDiamond.interface.parseLog({
                topics: [...evtLog.topics],
                data: evtLog.data,
            });
            if (!parsed || parsed.name !== ORDER_COMPLETED_EVENT) return;
            const { orderId, _order: order } = parsed.args as unknown as {
                orderId: bigint;
                _order: {
                    amount: bigint;
                    orderType: bigint;
                    user: string;
                    currency: string;
                };
            };
            const user = order.user;
            const txHash = evtLog.transactionHash;

            if (orderId === undefined || !user || !order) return;
            const orderType = Number(order.orderType);
            if (orderType !== ORDER_TYPE_BUY && orderType !== ORDER_TYPE_SELL) return;

            // Resolve the rate per the order's currency, falling back to the
            // default bps. ARS (Argentina) is 1% vs the default 2%.
            const currencyCode = decodeCurrency(order.currency);
            const bps = resolveCashbackBps(config, currencyCode);
            if (bps <= 0) {
                logger.debug(
                    `OrderCompleted: orderId=${orderId} currency=${currencyCode || 'n/a'} → 0 bps rate, skipping`,
                );
                return;
            }

            const amount: bigint = order.amount;
            const cashback = (amount * BigInt(bps)) / BPS_DENOMINATOR;
            if (cashback <= 0n) {
                logger.debug(
                    `OrderCompleted: orderId=${orderId} amount=${amount} → 0 cashback after bps, skipping`,
                );
                return;
            }

            // Non-B2B check: getOrderIntegrator returns address(0) for organic
            // orders. B2B-mediated orders fund cashback through a different
            // flow that we don't touch here.
            let integrator: string;
            try {
                integrator = await withTimeout(
                    httpDiamond.getOrderIntegrator(orderId),
                    5000,
                );
            } catch (err: any) {
                logger.error(
                    `OrderCompleted: getOrderIntegrator failed for orderId=${orderId}: ${err?.message ?? err}`,
                );
                return;
            }
            if (integrator && integrator !== '0x0000000000000000000000000000000000000000') {
                logger.debug(
                    `OrderCompleted: orderId=${orderId} is B2B (integrator=${integrator}), skipping`,
                );
                return;
            }

            const orderTypeLabel = orderType === ORDER_TYPE_BUY ? 'BUY' : 'SELL';
            logger.info(
                `OrderCompleted (eligible ${orderTypeLabel}, ${source}): orderId=${orderId} user=${user} amount=${amount} currency=${currencyCode || 'n/a'} bps=${bps} cashback=${cashback} txHash=${txHash}`,
            );

            await addCashbackJob(
                'IssueCashbackCredit',
                {
                    orderId: String(orderId),
                    user: String(user),
                    amount: cashback.toString(),
                },
                { jobId: `cashback-${String(orderId)}` },
            );
        } catch (err: any) {
            logger.error(
                { error: String(err?.message ?? err), source },
                'OrderCompleted processLog error',
            );
        }
    };

    // Replay OrderCompleted logs emitted while the WS was down. Runs on every
    // reconnect (not the first connect). Chunked + capped HTTP eth_getLogs;
    // credits are idempotent via jobId so replaying an already-processed block
    // is harmless. Aborts (without advancing) on RPC error so the next
    // reconnect retries the same gap rather than skipping it.
    const reconcileGap = async () => {
        if (lastProcessedBlock <= 0) return;
        let head: number;
        try {
            head = await withTimeout(httpProvider.getBlockNumber(), 10_000);
        } catch (err: any) {
            logger.error(
                `OrderCompleted: reconcileGap getBlockNumber failed: ${err?.message ?? err}`,
            );
            return;
        }
        let fromBlock = lastProcessedBlock + 1;
        if (fromBlock > head) return;
        const span = head - fromBlock + 1;
        if (span > MAX_BACKFILL_BLOCKS) {
            logger.warn(
                `OrderCompleted: gap of ${span} blocks exceeds cap ${MAX_BACKFILL_BLOCKS}; only replaying the most recent ${MAX_BACKFILL_BLOCKS}`,
            );
            fromBlock = head - MAX_BACKFILL_BLOCKS + 1;
        }
        logger.info(
            `OrderCompleted: reconciling gap blocks ${fromBlock}..${head} (${head - fromBlock + 1})`,
        );
        const collected: any[] = [];
        for (let start = fromBlock; start <= head; start += RECONCILE_CHUNK_BLOCKS) {
            const end = Math.min(start + RECONCILE_CHUNK_BLOCKS - 1, head);
            try {
                const logs = await withTimeout(
                    httpProvider.getLogs({
                        address: config.diamondAddress,
                        topics: [orderCompletedTopic],
                        fromBlock: start,
                        toBlock: end,
                    }),
                    20_000,
                );
                collected.push(...logs);
            } catch (err: any) {
                logger.error(
                    `OrderCompleted: reconcileGap getLogs ${start}..${end} failed: ${err?.message ?? err} — aborting, will retry on next reconnect`,
                );
                return;
            }
        }
        collected.sort(
            (a, b) => a.blockNumber - b.blockNumber || (a.index ?? 0) - (b.index ?? 0),
        );
        logger.info(`OrderCompleted: replaying ${collected.length} missed log(s)`);
        for (const log of collected) {
            await processLog(log, 'backfill');
        }
        if (head > lastProcessedBlock) lastProcessedBlock = head;
    };

    const setup = async () => {
        reconnectScheduled = false;
        const wsProvider = getBaseWsProvider(config);
        const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, wsProvider);

        // Baseline on first connect (no history replay), otherwise backfill the
        // gap that opened while the previous socket was down. Attaching the
        // live listener first and reconciling second means any block seen by
        // both paths is deduped by jobId rather than dropped.
        const handler = async (...args: any[]) => {
            const payload = args[args.length - 1];
            if (!payload || typeof payload !== 'object') return;
            await processLog(payload.log, 'live');
        };

        diamond.on(ORDER_COMPLETED_EVENT, handler);

        if (isFirstConnect) {
            isFirstConnect = false;
            try {
                lastProcessedBlock = await withTimeout(httpProvider.getBlockNumber(), 10_000);
                logger.info(
                    `OrderCompleted: first connect, baseline block=${lastProcessedBlock}`,
                );
            } catch (err: any) {
                lastProcessedBlock = 0;
                logger.warn(
                    `OrderCompleted: could not baseline block on first connect: ${err?.message ?? err}`,
                );
            }
        } else {
            await reconcileGap();
        }

        logger.info(
            `OrderCompleted listener attached for diamond: ${config.diamondAddress}` +
                (programmeOn
                    ? ` (cashback ${config.cashbackBps} bps → ${config.cashbackIntegratorAddress}` +
                      (overridesSummary ? `; per-currency ${overridesSummary})` : ')')
                    : ' (programme OFF — env unset)'),
        );

        void sendDiscordAlert(
            config.discordOnSuccessWebhookUrl,
            programmeOn
                ? `✅ WS connected in Executor: OrderCompleted listener attached (cashback ${config.cashbackBps} bps)`
                : '✅ WS connected in Executor: OrderCompleted listener attached (cashback programme OFF)',
        ).catch((e: any) => logger.warn(`OrderCompleted: Discord alert failed: ${e?.message}`));

        const ws: any =
            (wsProvider as any)._websocket ??
            (wsProvider as any).websocket ??
            (wsProvider as any)._ws ??
            null;

        if (!ws) {
            logger.warn('⚠️ OrderCompleted: ws handle not found; reconnect hooks not attached');
            return;
        }

        const scheduleReconnect = (reason: string) => {
            if (reconnectScheduled) return;
            reconnectScheduled = true;

            const msg = `⚠️ OrderCompleted WS issue: ${reason}. Reconnecting in 5s...`;
            logger.error(msg);

            void sendDiscordAlert(config.discordOnFailWebhookUrl, msg).catch(() => {});

            diamond.removeAllListeners(ORDER_COMPLETED_EVENT);

            try {
                if (typeof ws.close === 'function') ws.close();
            } catch (e) {
                logger.warn(`OrderCompleted: error closing ws: ${String(e)}`);
            }

            try {
                (wsProvider as any).destroy?.();
            } catch (e) {
                logger.warn(`OrderCompleted: error destroying wsProvider: ${String(e)}`);
            }

            setTimeout(() => {
                logger.info('OrderCompleted: reconnecting WS listener');
                void setup().catch((e: any) =>
                    logger.error(`OrderCompleted: reconnect setup failed: ${e?.message ?? e}`),
                );
            }, 5_000);
        };

        ws.onclose = (evt: any) => {
            const reason = `closed code=${evt?.code} reason=${evt?.reason ?? ''}`;
            scheduleReconnect(reason);
        };

        ws.onerror = (err: any) => {
            const reason = `error=${String(err?.message ?? err)}`;
            scheduleReconnect(reason);
        };
    };

    await setup();
}
