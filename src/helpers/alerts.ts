import { CommonConfig } from './config';
import { sendDiscordAlert } from './discord';

export { sendDiscordAlert };

export async function sendOnFail(config: CommonConfig, message: string): Promise<void> {
    await sendDiscordAlert(config.discordOnFailWebhookUrl, message);
}

export async function sendOnSuccess(config: CommonConfig, message: string): Promise<void> {
    await sendDiscordAlert(config.discordOnSuccessWebhookUrl, message);
}

export async function sendBalanceAlert(config: CommonConfig, message: string): Promise<void> {
    await sendDiscordAlert(config.discordBalanceWebhookUrl, message);
}
