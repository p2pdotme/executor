import { AbiCoder, getAddress, id, isHexString } from 'ethers';
import { centsToUsdc6 } from './payout';
import type { PrizerailStore, WinnerRow } from './store';
import { formatUsd } from './winners';

// Operator commands for winners the payout worker will not touch on its own
// (see README → "Paying held winners"). Every write names one row, checks its
// current status first, and reports a row that moved instead of overwriting.

export const TRANSFER_TOPIC = id('Transfer(address,address,uint256)');
const LIST_LIMIT = 200;

export const USAGE = `usage:
  list                                   rows that need a human
  approve   <drawingId> <position>       held (over the cap) → pending; the worker pays it
  retry     <drawingId> <position>       failed (never sent) → pending
  mark-paid <drawingId> <position> <tx>  record a transfer sent by hand (verified on-chain)`;

type ReceiptLog = { address: string; topics: readonly string[]; data: string };
export type ReceiptLike = { status: number | null; logs: readonly ReceiptLog[] };

export type ManualPayoutDeps = {
    campaign: string;
    usdcAddress: string;
    // Who ran the command; kept in last_error as an audit note.
    actor: string;
    store: Pick<
        PrizerailStore,
        'getWinner' | 'listNeedsAttention' | 'findPaidByTxHash' | 'approveHeld' | 'retryFailed' | 'markPaidByHand'
    >;
    getReceipt: (txHash: string) => Promise<ReceiptLike | null>;
};

/** Runs one command and returns the lines to print. Throws on refusal. */
export async function runManualPayout(argv: readonly string[], d: ManualPayoutDeps): Promise<string[]> {
    const [command, ...rest] = argv;
    switch (command) {
        case 'list':
            return list(d);
        case 'approve':
            return approve(d, ...parseKey(rest));
        case 'retry':
            return retry(d, ...parseKey(rest));
        case 'mark-paid': {
            const [drawingId, position] = parseKey(rest);
            return markPaid(d, drawingId, position, parseTxHash(rest[2]));
        }
        default:
            throw new Error(USAGE);
    }
}

async function list(d: ManualPayoutDeps): Promise<string[]> {
    const rows = await d.store.listNeedsAttention(d.campaign, LIST_LIMIT);
    if (rows.length === 0) return [`${d.campaign}: nothing needs a human`];
    return rows.map(
        (r) =>
            `${r.drawingId} #${r.position}  ${formatUsd(r.amountCents)}  ${r.payoutStatus}` +
            `${r.heldForManualPayout ? ' (held by Prizerail)' : ''}  wallet=${r.wallet ?? '—'}` +
            `${r.txHash ? `  tx=${r.txHash}` : ''}  ${r.holdReason ?? r.lastError ?? ''}`.trimEnd(),
    );
}

async function approve(d: ManualPayoutDeps, drawingId: string, position: number): Promise<string[]> {
    const row = await mustGet(d, drawingId, position);
    if (row.payoutStatus !== 'held') throw new Error(`${tag(row)} is ${row.payoutStatus}, not held`);
    if (row.heldForManualPayout) {
        throw new Error(`${tag(row)} is held by Prizerail (identity check / review) — resolve it in the Prizerail portal`);
    }
    if (!row.wallet) throw new Error(`${tag(row)} has no wallet — nothing to pay to`);
    const ok = await d.store.approveHeld(d.campaign, drawingId, position, `approved for auto-pay by ${d.actor}`);
    if (!ok) throw new Error(`${tag(row)} changed while approving — run list again`);
    return [`${tag(row)} approved: ${formatUsd(row.amountCents)} → ${row.wallet} is paid on the next scan (≤ 5 min)`];
}

async function retry(d: ManualPayoutDeps, drawingId: string, position: number): Promise<string[]> {
    const row = await mustGet(d, drawingId, position);
    if (row.payoutStatus !== 'failed') {
        throw new Error(
            `${tag(row)} is ${row.payoutStatus}, not failed. A 'manual' row may have been sent: check the chain and use mark-paid`,
        );
    }
    const ok = await d.store.retryFailed(d.campaign, drawingId, position, `retry requested by ${d.actor}`);
    if (!ok) throw new Error(`${tag(row)} changed while retrying — run list again`);
    return [`${tag(row)} queued again: ${formatUsd(row.amountCents)} → ${row.wallet} on the next scan`];
}

async function markPaid(d: ManualPayoutDeps, drawingId: string, position: number, txHash: string): Promise<string[]> {
    const row = await mustGet(d, drawingId, position);
    if (!['held', 'manual', 'failed'].includes(row.payoutStatus)) {
        throw new Error(`${tag(row)} is ${row.payoutStatus} — only held, manual or failed rows can be marked paid`);
    }
    if (!row.wallet) throw new Error(`${tag(row)} has no wallet to check the transfer against`);

    const receipt = await d.getReceipt(txHash);
    if (!receipt) throw new Error(`${txHash} is not mined (or not on this chain)`);
    if (receipt.status !== 1) throw new Error(`${txHash} reverted — nothing was paid`);
    const amount = centsToUsdc6(row.amountCents);
    if (!receipt.logs.some((log) => isTransfer(log, d.usdcAddress, row.wallet!, amount))) {
        throw new Error(`${txHash} has no USDC transfer of exactly ${formatUsd(row.amountCents)} to ${row.wallet}`);
    }
    const reused = (await d.store.findPaidByTxHash(d.campaign, txHash)).filter(
        (r) => r.drawingId !== drawingId || r.position !== position,
    );
    if (reused.length > 0) throw new Error(`${txHash} is already recorded for ${reused.map(tag).join(', ')}`);

    const ok = await d.store.markPaidByHand(d.campaign, drawingId, position, row.payoutStatus, txHash, `paid by hand, recorded by ${d.actor}`);
    if (!ok) throw new Error(`${tag(row)} changed while recording — run list again`);
    return [`${tag(row)} marked paid: ${formatUsd(row.amountCents)} → ${row.wallet} in ${txHash}`];
}

function isTransfer(log: ReceiptLog, usdc: string, to: string, amount: bigint): boolean {
    if (getAddress(log.address) !== getAddress(usdc)) return false;
    if (log.topics.length !== 3 || log.topics[0] !== TRANSFER_TOPIC) return false;
    const recipient = getAddress('0x' + log.topics[2].slice(26));
    const [value] = AbiCoder.defaultAbiCoder().decode(['uint256'], log.data);
    return recipient === getAddress(to) && value === amount;
}

async function mustGet(d: ManualPayoutDeps, drawingId: string, position: number): Promise<WinnerRow> {
    const row = await d.store.getWinner(d.campaign, drawingId, position);
    if (!row) throw new Error(`no winner ${drawingId} #${position} in campaign ${d.campaign}`);
    return row;
}

function parseKey(args: readonly string[]): [string, number] {
    const [drawingId, positionRaw] = args;
    if (!drawingId || positionRaw === undefined) throw new Error(USAGE);
    const position = Number(positionRaw);
    if (!Number.isInteger(position) || position < 0) throw new Error(`position must be a whole number, got "${positionRaw}"`);
    return [drawingId, position];
}

function parseTxHash(raw: string | undefined): string {
    if (!raw || !isHexString(raw, 32)) throw new Error(`tx hash must be 0x + 64 hex characters, got "${raw ?? ''}"`);
    return raw.toLowerCase();
}

const tag = (r: Pick<WinnerRow, 'drawingId' | 'position'>) => `${r.drawingId} #${r.position}`;
