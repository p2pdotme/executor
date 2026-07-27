import { Contract } from 'ethers';
import { ExecutorConfig } from '../helpers/config';
import { getBaseWsProvider, withTimeout } from '../helpers/provider';
import { DIAMOND_ABI } from '../helpers/abi';
import { logger } from '../helpers/logger';
import { addToggleJob, addAssignJob } from '../queue';
import { currencyMap, resolveOrderFromEventOrChain } from './utils';
import { trackOrderId } from '../utils/orderTracker';
import { sendDiscordAlert } from '../helpers/discord';

const ORDER_PLACED_EVENT = 'OrderPlaced';

// Reconnect backoff + alert throttling. A flapping WS (e.g. code=1011) used to
// reconnect on a flat 5s and fire a Discord ping every cycle. We now back off
// exponentially (5s→60s), only resetting to the floor once the heartbeat proves
// the socket has stayed up STABLE_UPTIME_MS, and collapse alerts to one "down"
// ping per outage (+ a periodic reminder) plus one "recovered" status.
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const STABLE_UPTIME_MS = 120_000;
const OUTAGE_REMINDER_EVERY = 12;

export async function attachOrderPlacedListener(config: ExecutorConfig) {
    const ASSIGN_DELAY_MS = config.assignDelayInSeconds * 1000 + 1_000; // 1s buffer

    let reconnectScheduled = false;

    // Reconnect/alert state (persists across reconnects). backoffMs grows on
    // each flap and is reset by the heartbeat once uptime clears the stability
    // window; connectedAt marks the current connection's start; outageAlerted
    // collapses repeat down-pings into one per outage.
    let backoffMs = MIN_BACKOFF_MS;
    let connectedAt = 0;
    let consecutiveFailures = 0;
    let outageAlerted = false;

    const setup = () => {
        reconnectScheduled = false;
        const wsProvider = getBaseWsProvider(config);
        const diamond = new Contract(config.diamondAddress, DIAMOND_ABI, wsProvider);

        const handler = async (...args: any[]) => {
            const payload = args[args.length - 1];

            try {
                if (!payload || typeof payload !== 'object') return;

                const txHash = payload.log?.transactionHash;
                if (!txHash) return;

                const order = await withTimeout(resolveOrderFromEventOrChain(payload, diamond));
                if (!order) return;

                const orderIdStr = String(order.id);
                await trackOrderId(orderIdStr);
                logger.debug(`OrderPlaced: tracking orderId=${orderIdStr} for autocancel`);

                const currencyStr = String(order.currency);
                const currencyName = currencyMap[currencyStr] ?? currencyStr;
                const circleId = String(order.circleId);

                logger.info(
                    `OrderPlaced: orderId=${orderIdStr} circleId=${circleId} currency=${currencyName} txHash=${txHash}`,
                );

                await addToggleJob(
                    config,
                    'ToggleMerchantsOffline',
                    { orderId: orderIdStr, circleId: circleId, currency: currencyStr },
                    { jobId: `toggle-${orderIdStr}`, delayMs: 0 },
                );

                logger.info(`OrderPlaced: enqueued ToggleMerchantsOffline for orderId=${orderIdStr}`);

                await addAssignJob(
                    config,
                    'AssignMerchants',
                    { orderId: orderIdStr, txHash },
                    { delayMs: ASSIGN_DELAY_MS },
                );

                logger.info(
                    `OrderPlaced: delayed AssignMerchants scheduled orderId=${orderIdStr} delay=${ASSIGN_DELAY_MS}ms`,
                );
            } catch (err: any) {
                logger.error({ error: String(err?.message ?? err) }, 'OrderPlaced listener error');
            }
        };

        diamond.on(ORDER_PLACED_EVENT, handler);
        logger.info(`OrderPlaced listener attached for diamond: ${config.diamondAddress}`);

        // connectedAt is 0 only before the very first connect — how we fire the
        // "connected" ping just once rather than on every reconnect flap.
        const wasFirstConnect = connectedAt === 0;
        connectedAt = Date.now();

        if (wasFirstConnect) {
            void sendDiscordAlert(
                config.discordOnSuccessWebhookUrl,
                '✅ WS connected in Executor: OrderPlaced listener attached',
            ).catch((e: any) => logger.warn(`OrderPlaced: Discord alert failed: ${e?.message}`));
        }

        const ws: any =
            (wsProvider as any)._websocket ??
            (wsProvider as any).websocket ??
            (wsProvider as any)._ws ??
            null;

        if (!ws) {
            logger.warn('⚠️ OrderPlaced: ws handle not found; reconnect hooks not attached');
            return;
        }

        // Heartbeat: onclose/onerror miss *silent* stalls — a socket that stays
        // "open" but stops delivering logs. Every 30s check readyState and issue a
        // real RPC call (block number) with a 10s cap; either failing triggers a
        // reconnect. Without this the executor can go dark on a dead WS with no
        // close event and stop assigning merchants until a manual restart.
        const heartbeatInterval = setInterval(async () => {
            try {
                if (ws.readyState !== 1) { // 1 = OPEN
                    scheduleReconnect(`ws not OPEN (readyState=${ws.readyState})`);
                    return;
                }
                const blockPromise = wsProvider.getBlockNumber();
                const timeout = new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('heartbeat timeout')), 10_000),
                );
                await Promise.race([blockPromise, timeout]);

                // Healthy tick: once the socket has been up past the stability
                // window, treat any prior outage as over — reset the backoff to
                // the floor and post a single "recovered" status.
                if (Date.now() - connectedAt >= STABLE_UPTIME_MS) {
                    backoffMs = MIN_BACKOFF_MS;
                    if (outageAlerted) {
                        void sendDiscordAlert(
                            config.discordOnSuccessWebhookUrl,
                            `✅ OrderPlaced WS recovered — stable for ${Math.round(
                                (Date.now() - connectedAt) / 1000,
                            )}s after ${consecutiveFailures} reconnect attempt(s)`,
                        ).catch(() => {});
                    }
                    outageAlerted = false;
                    consecutiveFailures = 0;
                }
            } catch (err: any) {
                scheduleReconnect(`heartbeat failed: ${String(err?.message ?? err)}`);
            }
        }, 30_000);

        const scheduleReconnect = (reason: string) => {
            if (reconnectScheduled) return;
            reconnectScheduled = true;
            clearInterval(heartbeatInterval);

            consecutiveFailures += 1;

            // A socket that stayed up past the stability window starts over at
            // the floor, so an isolated flap after a long-healthy connection
            // doesn't inherit a stale escalated delay.
            const wasStable =
                connectedAt > 0 && Date.now() - connectedAt >= STABLE_UPTIME_MS;
            if (wasStable) backoffMs = MIN_BACKOFF_MS;
            const waitMs = backoffMs;
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);

            const msg = `⚠️ OrderPlaced WS issue: ${reason}. Reconnecting in ${Math.round(
                waitMs / 1000,
            )}s (attempt ${consecutiveFailures})...`;
            logger.error(msg);

            // Collapse alert noise: one ping when an outage starts, then a
            // reminder every OUTAGE_REMINDER_EVERY attempts while it persists.
            // The "recovered" status is posted by the heartbeat.
            if (!outageAlerted) {
                outageAlerted = true;
                void sendDiscordAlert(config.discordOnFailWebhookUrl, msg).catch(() => {});
            } else if (consecutiveFailures % OUTAGE_REMINDER_EVERY === 0) {
                void sendDiscordAlert(
                    config.discordOnFailWebhookUrl,
                    `⏳ OrderPlaced WS still reconnecting after ${consecutiveFailures} attempts (last: ${reason})`,
                ).catch(() => {});
            }

            diamond.removeAllListeners(ORDER_PLACED_EVENT);

            try {
                if (typeof ws.close === 'function') ws.close();
            } catch (e) {
                logger.warn(`OrderPlaced: error closing ws: ${String(e)}`);
            }

            try {
                (wsProvider as any).destroy?.();
            } catch (e) {
                logger.warn(`OrderPlaced: error destroying wsProvider: ${String(e)}`);
            }

            setTimeout(() => {
                logger.info('OrderPlaced: reconnecting WS listener');
                setup();
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

    setup();
}
