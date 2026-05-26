// src/helpers/cashbackIntegratorAbi.ts
// Minimal ABI for the cashback integrator the B2B cashback programme
// writes to. The integrator exposes a single state-changing entrypoint
// the worker uses:
//
//   issueCredit(address user, uint256 amount)
//     gated to whitelisted issuers (the cashback wallet is the only
//     issuer on this deploy); records `amount` USDC of credit against
//     the user on the integrator's ledger. No USDC transfer here —
//     the credit is consumed at the user's next ticket purchase via
//     the integrator's vault-pull path.

export const CASHBACK_INTEGRATOR_ABI = [
    {
        "inputs": [
            { "internalType": "address", "name": "user", "type": "address" },
            { "internalType": "uint256", "name": "amount", "type": "uint256" }
        ],
        "name": "issueCredit",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [{ "internalType": "address", "name": "", "type": "address" }],
        "name": "issuedCredit",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [{ "internalType": "address", "name": "", "type": "address" }],
        "name": "creditIssuer",
        "outputs": [{ "internalType": "bool", "name": "", "type": "bool" }],
        "stateMutability": "view",
        "type": "function"
    }
] as const;
