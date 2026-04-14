import { Wallet, NonceManager, JsonRpcProvider, ethers } from 'ethers';
import IORedis from 'ioredis';
import { logger } from './logger';
import { sendDiscordAlert } from './discord';

export enum WalletRole {
    Toggle = 'toggle',
    Assign = 'assign',
    Sweeper = 'sweeper',
}

const ROLE_LABELS: Record<WalletRole, string> = {
    [WalletRole.Toggle]: 'Toggle',
    [WalletRole.Assign]: 'Assign',
    [WalletRole.Sweeper]: 'Sweeper',
};

// When a subwallet drops below minBalance, auto-top-up to this target
const TOP_UP_TARGET_ETH = '0.02';
// Alert operator when funding wallet itself drops below this
const FUNDING_LOW_THRESHOLD_ETH = '0.05';

export class WalletManager {
    private readonly signers = new Map<WalletRole, NonceManager>();
    private provider!: JsonRpcProvider;
    private initialized = false;

    /**
     * Priority order for each wallet on every boot:
     *   1. Env var set → use it (always authoritative; update env var to rotate wallet)
     *   2. Env var absent → load from Redis (persisted from a previous boot)
     *   3. Not in Redis either → generate a fresh wallet and persist to Redis
     */
    async init(provider: JsonRpcProvider, redis: IORedis): Promise<void> {
        this.provider = provider;

        const envKeys: Record<WalletRole, string | undefined> = {
            [WalletRole.Toggle]: process.env.TOGGLE_EXECUTOR,
            [WalletRole.Assign]: process.env.ASSIGN_EXECUTOR,
            [WalletRole.Sweeper]: process.env.ORDER_SWEEPER_EXECUTOR,
        };

        for (const role of Object.values(WalletRole) as WalletRole[]) {
            const redisKey = `executor:wallet:${role}:pk`;
            let pk: string;

            const envPk = envKeys[role];
            if (envPk) {
                // Env var wins — use it directly, no Redis involved
                pk = envPk;
                logger.info(`[WalletManager] ${ROLE_LABELS[role]} wallet loaded from env: ${new Wallet(pk).address}`);
            } else {
                const redisPk = await redis.get(redisKey);
                if (redisPk) {
                    // Persisted from a previous boot
                    pk = redisPk;
                    logger.info(`[WalletManager] ${ROLE_LABELS[role]} wallet loaded from Redis: ${new Wallet(pk).address}`);
                } else {
                    // First time with no env var — generate and persist
                    const fresh = Wallet.createRandom();
                    pk = fresh.privateKey;
                    await redis.set(redisKey, pk);
                    logger.info(`[WalletManager] ${ROLE_LABELS[role]} wallet generated and saved to Redis: ${fresh.address}`);
                }
            }

            const signer = new NonceManager(new Wallet(pk, provider));
            this.signers.set(role, signer);
        }

        this.initialized = true;
    }

    getSigner(role: WalletRole): NonceManager {
        if (!this.initialized) throw new Error('[WalletManager] not initialized — call init() first');
        return this.signers.get(role)!;
    }

    async getAddresses(): Promise<Record<WalletRole, string>> {
        const result: Partial<Record<WalletRole, string>> = {};
        for (const [role, signer] of this.signers) {
            result[role] = await signer.getAddress();
        }
        return result as Record<WalletRole, string>;
    }

    /** Send Discord startup message showing all wallet addresses so operator knows what to fund */
    async announceStartup(
        discordOnSuccessWebhookUrl: string,
        fundingAddress: string,
    ): Promise<void> {
        const addr = await this.getAddresses();
        const msg = [
            '🟢 **Executor started**',
            `Funding: \`${fundingAddress}\`  ← fund this`,
            `Toggle:  \`${addr[WalletRole.Toggle]}\``,
            `Assign:  \`${addr[WalletRole.Assign]}\``,
            `Sweeper: \`${addr[WalletRole.Sweeper]}\``,
        ].join('\n');
        logger.info(msg);
        await sendDiscordAlert(discordOnSuccessWebhookUrl, msg);
    }

    /**
     * Check balances of all subwallets + funding wallet.
     * Auto-tops-up subwallets below minBalanceWei from the funding wallet.
     * Balance alerts → balance channel. Auto-fund results → balance channel.
     */
    async checkAndFund(
        fundingSigner: NonceManager,
        minBalanceWei: bigint,
        discordBalanceWebhookUrl: string,
        dryRun = false,
    ): Promise<void> {
        const fundingAddress = await fundingSigner.getAddress();
        const topUpTargetWei = ethers.parseEther(TOP_UP_TARGET_ETH);
        const fundingLowThreshold = ethers.parseEther(FUNDING_LOW_THRESHOLD_ETH);
        const gasBuffer = ethers.parseEther('0.001');

        // Track available balance locally so each iteration sees the updated figure
        // after prior top-ups — prevents overdraft when multiple subwallets need funding
        let availableFundingBalance = await this.provider.getBalance(fundingAddress);

        if (availableFundingBalance < fundingLowThreshold) {
            const ethAmt = ethers.formatEther(availableFundingBalance);
            logger.warn(`[WalletManager] Funding wallet low: ${ethAmt} ETH`);
            await sendDiscordAlert(
                discordBalanceWebhookUrl,
                `🚨 **Funding wallet low** (\`${fundingAddress}\`): ${ethAmt} ETH — operator must top up`,
            );
        }

        for (const [role, signer] of this.signers) {
            const address = await signer.getAddress();
            const balance = await this.provider.getBalance(address);
            const label = ROLE_LABELS[role];

            if (balance >= minBalanceWei) {
                logger.debug(`[WalletManager] ${label} balance ok: ${ethers.formatEther(balance)} ETH`);
                continue;
            }

            const needed = topUpTargetWei - balance;
            logger.info(`[WalletManager] ${label} wallet low (${ethers.formatEther(balance)} ETH), auto-funding ${ethers.formatEther(needed)} ETH`);

            if (availableFundingBalance < needed + gasBuffer) {
                await sendDiscordAlert(
                    discordBalanceWebhookUrl,
                    `🔴 **Cannot auto-fund ${label}** (\`${address}\`): funding wallet has insufficient balance`,
                );
                continue;
            }

            if (dryRun) {
                logger.info(`[WalletManager][DRY_RUN] Would auto-fund ${label} (\`${address}\`): ${ethers.formatEther(needed)} ETH`);
                continue;
            }

            try {
                const tx = await fundingSigner.sendTransaction({ to: address, value: needed });
                await tx.wait(1);
                // Deduct from local tracker so the next subwallet check uses the correct figure
                availableFundingBalance -= needed;
                logger.info(`[WalletManager] Auto-funded ${label}: ${tx.hash}`);
                await sendDiscordAlert(
                    discordBalanceWebhookUrl,
                    `✅ **Auto-funded ${label}** (\`${address}\`): sent ${ethers.formatEther(needed)} ETH — \`${tx.hash}\``,
                );
            } catch (err: any) {
                logger.error(`[WalletManager] Auto-fund failed for ${label}: ${err.message}`);
                await sendDiscordAlert(
                    discordBalanceWebhookUrl,
                    `❌ **Auto-fund failed for ${label}** (\`${address}\`): ${err.message}`,
                );
            }
        }
    }
}
