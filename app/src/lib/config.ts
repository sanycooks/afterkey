const env = import.meta.env

export const NEAR_RPC: string = env.VITE_NEAR_RPC ?? 'https://rpc.testnet.fastnear.com'
export const FACTORY: string = env.VITE_FACTORY ?? 'afterkey.testnet'
export const MPC = 'v1.signer-prod.testnet'
export const SEPOLIA_RPC: string = env.VITE_SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com'
export const SEPOLIA_CHAIN_ID = 11155111
export const EXPLORER_ETH = 'https://sepolia.etherscan.io'
export const SOLANA_RPC: string = env.VITE_SOLANA_RPC ?? 'https://api.devnet.solana.com'
export const BTC_API: string = env.VITE_BTC_API ?? 'https://mempool.space/testnet4/api'
export const EXPLORER_SOL = (a: string) => `https://explorer.solana.com/address/${a}?cluster=devnet`
export const EXPLORER_BTC = (a: string) => `https://mempool.space/testnet4/address/${a}`
export const EXPLORER_NEAR = 'https://testnet.nearblocks.io'
export const TELEGRAM_BOT: string = env.VITE_TELEGRAM_BOT ?? 'AfterkeyAlertsBot'

/** Allowance for the app keys added to users' accounts (pays NEAR gas only). */
export const KEY_ALLOWANCE = 2n * 10n ** 24n
export const TGAS = 10n ** 12n

export const WALLET_PATHS = { eth: 'eth-1', sol: 'sol-1', btc: 'btc-1' } as const

/**
 * Telegram deep link that subscribes this chat to a will's alerts.
 * Start payloads can't contain dots, so the owner's account travels as base64url.
 */
export function telegramLink(role: 'owner' | 'guardian' | 'heir', ownerAccount: string): string {
  const b64 = btoa(ownerAccount).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const payload = (role === 'guardian' ? 'g' : role === 'heir' ? 'h' : 'o') + b64
  return payload.length <= 64 ? `https://t.me/${TELEGRAM_BOT}?start=${payload}` : `https://t.me/${TELEGRAM_BOT}`
}

/** Reown (WalletConnect) project ID. Public by design; protected by the allowed domains set in the Reown dashboard. */
export const REOWN_PROJECT_ID: string = env.VITE_REOWN_PROJECT_ID ?? '2bfe5680e52ac9fe58e3514157b37cd1'
