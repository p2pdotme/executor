import ky from 'ky';
import { ContractCallerConfig } from './config';
import { logger } from './logger';
import { ethers, Wallet } from 'ethers';

export const sendTelegramMessage = async (
    telegramBotToken: string,
    telegramChannelId: string,
    telegramTopicId: string,
    message: string
) => {
    try {
        const res = await ky.post(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
            json: { chat_id: telegramChannelId, text: message, message_thread_id: telegramTopicId },
            timeout: 30000,
            retry: { limit: 2 }
        });
        logger.info(`☑️ Telegram send ok status=${res.status}`);
        return true;
    } catch (err) {
        const status = (err as any)?.response?.status ?? 'unknown';
        const body = (err as any)?.response ? await (err as any).response.text().catch(() => String((err as any).message)) : String(err);
        const msg = `❌ Telegram message failed: status=${status} body=${body}`;
        logger.error(msg);
        return false;
    }
};

export const sendOnFail = async (config: ContractCallerConfig, message: string) => {
    if (!config.onFailBotToken || !config.onFailChanneld || !config.onFailTopicId) return;
    try {
        await sendTelegramMessage(config.onFailBotToken, config.onFailChanneld, config.onFailTopicId, message);
    } catch (err: any) {
        logger.warn(`on-fail telegram send failed ${String(err?.message)}`);
    }
};

export async function ensureSufficientBalance(config: ContractCallerConfig, signer: Wallet) {
    try {
        const provider = signer.provider;
        if (!provider) {
            logger.error('provider is null');
            return;
        }
        const address = await signer.getAddress();
        const balanceWei = await provider.getBalance(address);
        const eth = Number(ethers.formatEther(balanceWei));

        if (eth < config.minBaseBalanceEth) {
            const msg = `⚠️ Low balance for ${address}: ${eth} ETH (min required ${config.minBaseBalanceEth})`;
            logger.warn(msg);

            await sendOnFail(config, msg);
            return;
        }

        logger.debug(`balance ok for ${address}: ${eth} ETH`);

    } catch (err: any) {
        logger.error(`balance check error: ${err.message}`);
    }
}
