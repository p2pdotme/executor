import { Wallet, NonceManager, JsonRpcProvider, ethers } from 'ethers';
import { logger } from './logger';
import { sendDiscordAlert } from './discord';

export enum WalletRole {
    Toggle = 'toggle',
    Assign = 'assign',
    Sweeper = 'sweeper',
    Cashback = 'cashback',
    Keeper = 'keeper',
}

const ROLE_LABELS: Record<WalletRole, string> = {
    [WalletRole.Toggle]: 'Toggle',
    [WalletRole.Assign]: 'Assign',
    [WalletRole.Sweeper]: 'Sweeper',
    [WalletRole.Cashback]: 'Cashback',
    [WalletRole.Keeper]: 'Keeper',
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
     * Every signing key comes from the environment and nowhere else. Keys are
     * never generated at runtime and never written to Redis (or any other
     * store) — the secret manager of the host platform is the single source of
     * truth, and rotating a wallet means updating its env var and redeploying.
     * A missing key is a hard boot failure rather than a silent auto-generated
     * wallet that nobody funds or whitelists.
     */
    async init(provider: JsonRpcProvider): Promise<void> {
        this.provider = provider;

        const envVarNames: Record<WalletRole, string> = {
            [WalletRole.Toggle]: 'TOGGLE_EXECUTOR',
            [WalletRole.Assign]: 'ASSIGN_EXECUTOR',
            [WalletRole.Sweeper]: 'ORDER_SWEEPER_EXECUTOR',
            // Must match the address whitelisted via
            // CashbackIntegrator.setCreditIssuer(issuer, true).
            [WalletRole.Cashback]: 'CASHBACK_EXECUTOR',
            // Signs the daily permissionless keeper txs (approveUnstakeBatch +
            // blacklistInactiveMerchants) AND the insurance settleClaim txs.
            // All are permissionless, so any funded wallet works — no on-chain
            // whitelist needed.
            [WalletRole.Keeper]: 'KEEPER_EXECUTOR',
        };

        for (const role of Object.values(WalletRole) as WalletRole[]) {
            const envVar = envVarNames[role];
            const pk = (process.env[envVar] ?? '').trim();
            if (!pk) {
                throw new Error(
                    `[WalletManager] ${envVar} is not set — every executor wallet key must be provided via the environment`,
                );
            }

            const signer = new NonceManager(new Wallet(pk, provider));
            logger.info(`[WalletManager] ${ROLE_LABELS[role]} wallet loaded from ${envVar}: ${await signer.getAddress()}`);
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
            `Funding:  \`${fundingAddress}\`  ← fund this`,
            `Toggle:   \`${addr[WalletRole.Toggle]}\``,
            `Assign:   \`${addr[WalletRole.Assign]}\``,
            `Sweeper:  \`${addr[WalletRole.Sweeper]}\``,
            `Cashback: \`${addr[WalletRole.Cashback]}\`  ← whitelist via integrator.setCreditIssuer`,
            `Keeper:   \`${addr[WalletRole.Keeper]}\` ← approveUnstakeBatch + blacklistInactiveMerchants + settleClaim`,
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
