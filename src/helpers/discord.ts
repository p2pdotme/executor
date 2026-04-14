import ky from 'ky';
import { logger } from './logger';

export async function sendDiscordAlert(webhookUrl: string, message: string): Promise<void> {
    if (!webhookUrl) return;
    try {
        await ky.post(webhookUrl, {
            json: { content: message, flags: 4 },
            timeout: 10_000,
            retry: { limit: 2 },
        });
    } catch (err: any) {
        const status = (err as any)?.response?.status ?? 'unknown';
        logger.error(`Discord webhook failed: status=${status} err=${String(err?.message ?? err)}`);
    }
}
