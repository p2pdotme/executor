import ky from 'ky';
import { logger } from './logger';
import { scrub } from './scrub';

export async function sendDiscordAlert(webhookUrl: string, message: string): Promise<void> {
    if (!webhookUrl) return;
    try {
        await ky.post(webhookUrl, {
            // Alert bodies are assembled from upstream error strings, which can
            // carry the RPC URL (and with it the API key) that produced them.
            // Discord is a far weaker place to store a credential than the env.
            json: { content: scrub(message), flags: 4 },
            timeout: 10_000,
            retry: { limit: 2 },
        });
    } catch (err: any) {
        const status = (err as any)?.response?.status ?? 'unknown';
        logger.error(`Discord webhook failed: status=${status} err=${String(err?.message ?? err)}`);
    }
}
