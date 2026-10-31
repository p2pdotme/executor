import ky from 'ky';
import { logger } from './logger';

// Returns whether Discord accepted the message. An unset webhook counts as
// delivered (nothing to send); a failed call is logged and returns false so
// callers that must not lose the message can retry later.
export async function trySendDiscordAlert(webhookUrl: string, message: string): Promise<boolean> {
    if (!webhookUrl) return true;
    try {
        await ky.post(webhookUrl, {
            json: { content: message, flags: 4 },
            timeout: 10_000,
            retry: { limit: 2 },
        });
        return true;
    } catch (err: any) {
        const status = (err as any)?.response?.status ?? 'unknown';
        logger.error(`Discord webhook failed: status=${status} err=${String(err?.message ?? err)}`);
        return false;
    }
}

export async function sendDiscordAlert(webhookUrl: string, message: string): Promise<void> {
    await trySendDiscordAlert(webhookUrl, message);
}
