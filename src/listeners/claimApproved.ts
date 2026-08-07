import { Contract } from 'ethers';
import { ExecutorConfig } from '../helpers/config';
import { getBaseWsProvider } from '../helpers/provider';
import { INSURANCE_ABI } from '../helpers/insuranceAbi';
import { logger } from '../helpers/logger';
import { addSettleClaimJob } from '../queue';
import { sendDiscordAlert } from '../helpers/discord';

const CLAIM_APPROVED_EVENT = 'ClaimApproved';
// Small buffer added on top of payoutEligibleAt so the settle tx never lands a
// block or two early and reverts InsurancePayoutDelayNotMet in presim.
const SETTLE_BUFFER_MS = 15_000;

// Reconnect backoff + alert throttling — same policy as orderPlaced/orderCompleted.
// A flapping WS on a flat 5s reconnect with unconditional pings produces two
// Discord messages every 5s indefinitely.
const MIN_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;
const STABLE_UPTIME_MS = 120_000;
const OUTAGE_REMINDER_EVERY = 12;

// Watches the Insurance Diamond for ClaimApproved. Each approval carries
// payoutEligibleAt (reviewedAt + payoutDelay); we schedule a delayed settleClaim
// job to fire exactly then. The reconciliation scanner (settleClaimScanner) is
// the safety net for approvals that happened while the WS was down or before
// this listener attached. Mirrors orderPlaced.ts (heartbeat + reconnect) so a
// silent WS stall self-heals instead of going dark.
export async function attachClaimApprovedListener(config: ExecutorConfig) {
    if (!config.insuranceDiamondAddress) {
        logger.info('ClaimApproved: INSURANCE_DIAMOND_ADDRESS unset — listener not attached');
        return;
    }

    let reconnectScheduled = false;

    // Reconnect/alert state, persists across reconnects. See orderPlaced.ts.
    let backoffMs = MIN_BACKOFF_MS;
    let connectedAt = 0;
    let consecutiveFailures = 0;
    let outageAlerted = false;

    const setup = () => {
        reconnectScheduled = false;
        const wsProvider = getBaseWsProvider(config);
        const insurance = new Contract(config.insuranceDiamondAddress, INSURANCE_ABI, wsProvider);

        const handler = async (...args: any[]) => {
            const payload = args[args.length - 1];

            try {
                if (!payload || typeof payload !== 'object') return;

                const txHash = payload.log?.transactionHash;

                // Robustly pull claimId + payoutEligibleAt from either the spread
                // positional args or the decoded event args.
                const claimIdRaw = payload.args?.claimId ?? args[0];
                const payoutEligibleAtRaw = payload.args?.payoutEligibleAt ?? args[3];
                if (claimIdRaw == null || payoutEligibleAtRaw == null) {
                    logger.warn(
                        `ClaimApproved: could not decode claimId/payoutEligibleAt, dropping approval txHash=${txHash} — the reconciliation scanner will pick this claim up`,
                    );
                    return;
                }

                const claimId = String(claimIdRaw);
                const payoutEligibleAtSec = Number(payoutEligibleAtRaw);
                const nowSec = Math.floor(Date.now() / 1000);
                const delayMs = Math.max(0, (payoutEligibleAtSec - nowSec) * 1000) + SETTLE_BUFFER_MS;

                logger.info(
                    `ClaimApproved: claimId=${claimId} payoutEligibleAt=${payoutEligibleAtSec} delayMs=${delayMs} txHash=${txHash}`,
                );

                await addSettleClaimJob(
                    { claimId },
                    { jobId: `settle-${claimId}`, delayMs },
                );

                logger.info(`ClaimApproved: scheduled delayed SettleClaim for claimId=${claimId}`);
            } catch (err: any) {
                logger.error({ error: String(err?.message ?? err) }, 'ClaimApproved listener error');
            }
        };

        insurance.on(CLAIM_APPROVED_EVENT, handler);
        logger.info(`ClaimApproved listener attached for insurance diamond: ${config.insuranceDiamondAddress}`);

        // connectedAt is 0 only before the very first connect — how we fire the
        // "connected" ping just once rather than on every reconnect flap.
        const wasFirstConnect = connectedAt === 0;
        connectedAt = Date.now();

        if (wasFirstConnect) {
            void sendDiscordAlert(
                config.discordOnSuccessWebhookUrl,
                '✅ WS connected in Executor: ClaimApproved listener attached',
            ).catch((e: any) => logger.warn(`ClaimApproved: Discord alert failed: ${e?.message}`));
        }

        const ws: any =
            (wsProvider as any)._websocket ??
            (wsProvider as any).websocket ??
            (wsProvider as any)._ws ??
            null;

        if (!ws) {
            logger.warn('⚠️ ClaimApproved: ws handle not found; reconnect hooks not attached');
            return;
        }

        // Heartbeat: catch silent stalls (socket "open" but no logs delivered).
        // Every 30s check readyState + issue a real RPC call with a 10s cap;
        // either failing triggers a reconnect.
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
                // window, treat any prior outage as over.
                if (Date.now() - connectedAt >= STABLE_UPTIME_MS) {
                    backoffMs = MIN_BACKOFF_MS;
                    if (outageAlerted) {
                        void sendDiscordAlert(
                            config.discordOnSuccessWebhookUrl,
                            `✅ ClaimApproved WS recovered — stable for ${Math.round(
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

            const wasStable =
                connectedAt > 0 && Date.now() - connectedAt >= STABLE_UPTIME_MS;
            if (wasStable) backoffMs = MIN_BACKOFF_MS;
            const waitMs = backoffMs;
            backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);

            const msg = `⚠️ ClaimApproved WS issue: ${reason}. Reconnecting in ${Math.round(
                waitMs / 1000,
            )}s (attempt ${consecutiveFailures})...`;
            logger.error(msg);

            // Collapse alert noise: one ping when an outage starts, then a
            // reminder every OUTAGE_REMINDER_EVERY attempts while it persists.
            if (!outageAlerted) {
                outageAlerted = true;
                void sendDiscordAlert(config.discordOnFailWebhookUrl, msg).catch(() => {});
            } else if (consecutiveFailures % OUTAGE_REMINDER_EVERY === 0) {
                void sendDiscordAlert(
                    config.discordOnFailWebhookUrl,
                    `⏳ ClaimApproved WS still reconnecting after ${consecutiveFailures} attempts (last: ${reason})`,
                ).catch(() => {});
            }

            insurance.removeAllListeners(CLAIM_APPROVED_EVENT);

            try {
                if (typeof ws.close === 'function') ws.close();
            } catch (e) {
                logger.warn(`ClaimApproved: error closing ws: ${String(e)}`);
            }

            try {
                (wsProvider as any).destroy?.();
            } catch (e) {
                logger.warn(`ClaimApproved: error destroying wsProvider: ${String(e)}`);
            }

            setTimeout(() => {
                logger.info('ClaimApproved: reconnecting WS listener');
                setup();
            }, waitMs);
        };

        ws.onclose = (evt: any) => {
            scheduleReconnect(`closed code=${evt?.code} reason=${evt?.reason ?? ''}`);
        };

        ws.onerror = (err: any) => {
            scheduleReconnect(`error=${String(err?.message ?? err)}`);
        };
    };

    setup();
}
