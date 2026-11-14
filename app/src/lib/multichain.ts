// SOL and BTC addresses of a will, derived the same way as its ETH address:
// from (will contract account, derivation path) through NEAR Chain Signatures.
import { Connection } from '@solana/web3.js'
import { chainAdapters } from 'chainsig.js'
import { BTC_API, SOLANA_RPC } from './config'
import { csContract } from './eth'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const anyContract = csContract as any
const sol = new chainAdapters.solana.Solana({ solanaConnection: new Connection(SOLANA_RPC), contract: anyContract })
const btc = new chainAdapters.btc.Bitcoin({
  network: 'testnet',
  contract: anyContract,
  btcRpcAdapter: new chainAdapters.btc.BTCRpcAdapters.Mempool(BTC_API),
})

export interface ChainWallet {
  address: string
  /** Human units: SOL or BTC. null while loading or if the network didn't answer. */
  balance: number | null
}

export async function solWallet(will: string, path: string): Promise<ChainWallet> {
  const { address } = await sol.deriveAddressAndPublicKey(will, path)
  const balance = await sol.getBalance(address).then((b) => Number(b.balance) / 1e9).catch(() => null)
  return { address, balance }
}

export async function btcWallet(will: string, path: string): Promise<ChainWallet> {
  const { address } = await btc.deriveAddressAndPublicKey(will, path)
  const balance = await btc.getBalance(address).then((b) => Number(b.balance) / 1e8).catch(() => null)
  return { address, balance }
}
