const env = import.meta.env

export const NEAR_RPC: string = env.VITE_NEAR_RPC ?? 'https://rpc.testnet.near.org'
export const FACTORY: string = env.VITE_FACTORY ?? 'afterkey.testnet'
export const MPC = 'v1.signer-prod.testnet'
export const SEPOLIA_RPC: string = env.VITE_SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com'
export const SEPOLIA_CHAIN_ID = 11155111
export const EXPLORER_ETH = 'https://sepolia.etherscan.io'
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
export function telegramLink(role: 'owner' | 'guardian', ownerAccount: string): string {
  const b64 = btoa(ownerAccount).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const payload = (role === 'guardian' ? 'g' : 'o') + b64
  return payload.length <= 64 ? `https://t.me/${TELEGRAM_BOT}?start=${payload}` : `https://t.me/${TELEGRAM_BOT}`
}
