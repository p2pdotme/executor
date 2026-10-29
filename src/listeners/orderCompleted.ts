import { Contract } from 'ethers';
import { ExecutorConfig } from '../helpers/config';
import { getBaseWsProvider, getBaseHttpProvider, withTimeout } from '../helpers/provider';
import { DIAMOND_ABI } from '../helpers/abi';
import { logger } from '../helpers/logger';
import { addCashbackJob } from '../queue';
import { addPrizerailEntryJob } from '../queue/prizerailQueues';
import { entriesForOrder } from '../prizerail/entries';
import { isCurrencyExcluded } from '../prizerail/config';
import {
    anyRatePositive,
    computeCashback,
    decodeCurrency,
    resolveCashbackBps,
} from './cashbackEligibility';
import { sendDiscordAlert } from '../helpers/discord';

const ORDER_COMPLETED_EVENT = 'OrderCompleted';

// OrderProcessorStorage.OrderType enum: { BUY=0, SELL=1, PAY=2 }
const ORDER_TYPE_BUY = 0;
const ORDER_TYPE_SELL = 1;

// Gap-reconcile tuning. On WS reconnect we replay OrderCompleted logs that
// were emitted while the socket was down via HTTP eth_getLogs. Chunk size
// matches the proven order-scanner lookback (syncOrderIds uses a 2500-block
// getLogs). The cap keeps the reconnect scan bounded — a longer gap than this
// is treated as an outage the operator handles, not something we self-heal by
// scanning the whole chain. Re-issue is safe regardless: the cashback jobId is
// the orderId, so replaying an already-credited block never double-counts.
const RECONCILE_CHUNK_BLOCKS = 2_500;
const MAX_BACKFILL_BLOCKS = 5_000;

// Reconnect backoff + alert throttling. A flapping WS (e.g. code=1011) used to
// reconnect on a flat 5s and fire a Discord ping on every cycle — ~8 alerts/min
// of pure noise. We now back off exponentially (5s→60s) and only reset to the
// floor after the socket has stayed up STABLE_UPTIME_MS, so a single flap can't
// keep resetting the backoff. Alerts are collapsed to one "down" ping per
// outage plus a periodic reminder, then one "recovered" status.
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const STABLE_UPTIME_MS = 120_000;
// Emit a reminder every Nth failed attempt while an outage persists.
const OUTAGE_REMINDER_EVERY = 12;

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
 * Prizerail (Nov 2026): the same eligibility rules also feed the Prizerail
 * draw programme that replaces cashback credit. When PRIZERAIL_API_KEY is set,
 * each eligible order additionally enqueues one SendPrizerailEntry job with
 * one entry per whole USDC unless the market is excluded (see prizerail/).
 * Both programmes can
 * run side by side during the cutover; each is gated by its own env.
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

    // Reconnect/alert state (persists across reconnects). backoffMs grows on
    // each flap and only resets once the socket proves stable; connectedAt marks
    // the current connection's start so we can measure uptime without a
    // heartbeat. outageAlerted collapses repeat down-pings into one per outage.
    let backoffMs = MIN_BACKOFF_MS;
    let connectedAt = 0;
    let consecutiveFailures = 0;
    let outageAlerted = false;

    // Cashback is on when its integrator is configured AND at least one
    // positive rate exists — the default bps or a per-currency override (an
    // operator may zero the default but still credit one market). Prizerail
    // is on whenever its key is set: its rule (one entry per whole USDC,
    // minus the site's excluded markets) does not use the cashback rates.
    const cashbackOn = !!config.cashbackIntegratorAddress && anyRatePositive(config);
    const prizerail = config.prizerail;
    const prizerailOn = !!prizerail;
    const programmeOn = cashbackOn || prizerailOn;
    if (!programmeOn) {
        logger.info(
            'OrderCompleted: cashback + prizerail programmes disabled (env unset) — listener attached as no-op so toggling env later does not require restart',
        );
    } else {
        logger.info(
            `OrderCompleted: programmes — cashback=${cashbackOn ? 'on' : 'off'} prizerail=${prizerailOn ? `on (${config.prizerail?.campaignSlug})` : 'off'}`,
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

            const currencyCode = decodeCurrency(order.currency);
            const amount: bigint = order.amount;

            // Cashback: rate per the order's currency, falling back to the
            // default bps (per-market overrides come from CASHBACK_BPS_BY_CURRENCY).
            const bps = cashbackOn ? resolveCashbackBps(config, currencyCode) : 0;
            const cashback = bps > 0 ? computeCashback(amount, bps) : 0n;

            // Prizerail: one entry per whole USDC unless the market is excluded.
            const excluded = !!prizerail && isCurrencyExcluded(prizerail, currencyCode);
            const entries = prizerail && !excluded ? entriesForOrder(amount) : 0;

            if (cashback <= 0n && entries <= 0) {
                logger.debug(
                    `OrderCompleted: orderId=${orderId} amount=${amount} currency=${currencyCode || 'n/a'} → nothing to do (cashback bps=${bps}, draw ${excluded ? 'market excluded' : '0 entries'}), skipping`,
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
                `OrderCompleted (eligible ${orderTypeLabel}, ${source}): orderId=${orderId} user=${user} amount=${amount} currency=${currencyCode || 'n/a'} cashback=${cashback} (bps=${bps}) entries=${entries} txHash=${txHash}`,
            );

            if (cashback > 0n) {
                await addCashbackJob(
                    'IssueCashbackCredit',
                    {
                        orderId: String(orderId),
                        user: String(user),
                        amount: cashback.toString(),
                    },
                    { jobId: `cashback-${String(orderId)}` },
                );
            }

            if (entries > 0) {
                await addPrizerailEntryJob({
                    orderId: String(orderId),
                    user: String(user),
                    entries,
                });
            }
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

        // Mark this connection's start so scheduleReconnect / the stability
        // timer can measure uptime. connectedAt is 0 only before the very first
        // connect, which is how we fire the "connected" ping just once (not on
        // every reconnect during a flap).
        const wasFirstConnect = connectedAt === 0;
        connectedAt = Date.now();
        const myConnectedAt = connectedAt;

        logger.info(
            `OrderCompleted listener attached for diamond: ${config.diamondAddress}` +
                (programmeOn
                    ? ` (cashback ${config.cashbackBps} bps → ${config.cashbackIntegratorAddress}` +
                      (overridesSummary ? `; per-currency ${overridesSummary})` : ')')
                    : ' (programme OFF — env unset)'),
        );

        if (wasFirstConnect) {
            void sendDiscordAlert(
                config.discordOnSuccessWebhookUrl,
                programmeOn
                    ? `✅ WS connected in Executor: OrderCompleted listener attached (cashback ${config.cashbackBps} bps)`
                    : '✅ WS connected in Executor: OrderCompleted listener attached (cashback programme OFF)',
            ).catch((e: any) => logger.warn(`OrderCompleted: Discord alert failed: ${e?.message}`));
        }

        // One-shot stability check (not a recurring heartbeat): if this same
        // connection is still live after STABLE_UPTIME_MS, treat the outage as
        // over — reset the backoff to the floor and, if we'd alerted a WS
        // issue, post a single "recovered" status. Invalidated by connectedAt
        // changing on any intervening reconnect, so a flapping socket never
        // trips it.
        setTimeout(() => {
            if (connectedAt !== myConnectedAt) return;
            if (outageAlerted) {
                void sendDiscordAlert(
                    config.discordOnSuccessWebhookUrl,
                    `✅ OrderCompleted WS recovered — stable for ${Math.round(
                        STABLE_UPTIME_MS / 1000,
                    )}s after ${consecutiveFailures} reconnect attempt(s)`,
                ).catch(() => {});
            }
            backoffMs = MIN_BACKOFF_MS;
            consecutiveFailures = 0;
            outageAlerted = false;
        }, STABLE_UPTIME_MS);

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

            consecutiveFailures += 1;

            // A socket that stayed up past the stability window is treated as a
            // fresh start: reset the backoff to the floor before computing this
            // wait, so an isolated flap after a long-healthy connection doesn't
            // inherit a stale escalated delay.
            const wasStable =
                connectedAt > 0 && Date.now() - connectedAt >= STABLE_UPTIME_MS;
            if (wasStable) backoffMs = MIN_BACKOFF_MS;
            const waitMs = backoffMs;
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);

            const msg = `⚠️ OrderCompleted WS issue: ${reason}. Reconnecting in ${Math.round(
                waitMs / 1000,
            )}s (attempt ${consecutiveFailures})...`;
            logger.error(msg);

            // Collapse alert noise: one ping when an outage starts, then a
            // reminder every OUTAGE_REMINDER_EVERY attempts while it persists.
            // The "recovered" status is posted by the stability timer in setup.
            if (!outageAlerted) {
                outageAlerted = true;
                void sendDiscordAlert(config.discordOnFailWebhookUrl, msg).catch(() => {});
            } else if (consecutiveFailures % OUTAGE_REMINDER_EVERY === 0) {
                void sendDiscordAlert(
                    config.discordOnFailWebhookUrl,
                    `⏳ OrderCompleted WS still reconnecting after ${consecutiveFailures} attempts (last: ${reason})`,
                ).catch(() => {});
            }

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
            }, waitMs);
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
