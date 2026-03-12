import ky from 'ky';
import { CommonConfig } from './config';
import { logger } from './logger';
import { ethers, Wallet, NonceManager } from 'ethers';

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

export const sendOnFail = async (config: CommonConfig, message: string) => {
    if (!config.onFailBotToken || !config.onFailChanneld || !config.onFailTopicId) return;
    try {
        await sendTelegramMessage(config.onFailBotToken, config.onFailChanneld, config.onFailTopicId, message);
    } catch (err: any) {
        logger.warn(`on-fail telegram send failed ${String(err?.message)}`);
    }
};

export async function ensureSufficientBalance(config: CommonConfig, signer: Wallet | NonceManager) {
    try {
        const provider = (signer as any).provider ?? (signer as NonceManager).signer?.provider;
        if (!provider) {
            logger.error('provider is null');
            return;
        }
        const address = await signer.getAddress();
        const priceUpdaterAddress = '0x7055777da2E97c8c05186209cbfEe3Fc20BFd61C';
        const arsPriceUpdaterAddress = '0x6988b3804C1Ec673775e7ED5039Ff4C1f9E373fF';

        let hasLowBalance = false;

        for (const addr of [address, priceUpdaterAddress, arsPriceUpdaterAddress]) {
            const balanceWei = await provider.getBalance(addr);
            const eth = Number(ethers.formatEther(balanceWei));

            if (eth < config.minBaseBalanceEth) {
                hasLowBalance = true;
                const msg = `⚠️ Low balance for ${addr}: ${eth} ETH (min required ${config.minBaseBalanceEth})`;
                logger.warn(msg);
                await sendTelegramMessage(
                    config.onFailBotToken,
                    config.onFailChanneld,
                    config.balanceTopicId,
                    msg
                );
            } else {
                logger.debug(`balance ok for ${addr}: ${eth} ETH`);
            }
        }

        if (hasLowBalance) return;

    } catch (err: any) {
        logger.error(`balance check error: ${err.message}`);
    }
}
