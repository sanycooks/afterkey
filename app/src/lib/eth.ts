import { createPublicClient, encodeFunctionData, erc20Abi, http, keccak256, serializeTransaction, type Hex } from 'viem'
import { sepolia } from 'viem/chains'
import { chainAdapters, contracts, utils as csUtils, type MPCSignature } from 'chainsig.js'
import { MPC, NEAR_RPC, SEPOLIA_CHAIN_ID, SEPOLIA_RPC } from './config'

export const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) })

export const csContract = new contracts.ChainSignatureContract({ networkId: 'testnet', contractId: MPC, fallbackRpcUrls: [NEAR_RPC] })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const evm = new chainAdapters.evm.EVM({ publicClient: client as any, contract: csContract })

/** The ETH address a will controls for a derivation path. Same on every EVM chain. */
export async function deriveEthAddress(will: string, path: string): Promise<Hex> {
  const { address } = await evm.deriveAddressAndPublicKey(will, path)
  return address as Hex
}

/** EthTx exactly as the will contract expects it (numbers as strings). */
export interface EthTxArgs {
  chain_id: string
  nonce: string
  max_priority_fee_per_gas: string
  max_fee_per_gas: string
  gas_limit: string
  to: string
  value: string
  data: string
}

export async function buildTx(from: Hex, to: Hex, value: bigint, data: Hex = '0x'): Promise<EthTxArgs> {
  const [nonce, fees, gas] = await Promise.all([
    client.getTransactionCount({ address: from, blockTag: 'pending' }),
    client.estimateFeesPerGas(),
    data === '0x' ? Promise.resolve(21000n) : client.estimateGas({ account: from, to, value, data }),
  ])
  return {
    chain_id: String(SEPOLIA_CHAIN_ID),
    nonce: String(nonce),
    max_priority_fee_per_gas: String(fees.maxPriorityFeePerGas),
    max_fee_per_gas: String(fees.maxFeePerGas),
    gas_limit: String(gas),
    to: to.toLowerCase(),
    value: String(value),
    data,
  }
}

export function maxFee(t: EthTxArgs): bigint {
  return BigInt(t.gas_limit) * BigInt(t.max_fee_per_gas)
}

function toViem(t: EthTxArgs) {
  return {
    type: 'eip1559' as const,
    chainId: Number(t.chain_id),
    nonce: Number(t.nonce),
    maxPriorityFeePerGas: BigInt(t.max_priority_fee_per_gas),
    maxFeePerGas: BigInt(t.max_fee_per_gas),
    gas: BigInt(t.gas_limit),
    to: t.to as Hex,
    value: BigInt(t.value),
    data: (t.data === '0x' ? undefined : t.data) as Hex | undefined,
    accessList: [],
  }
}

/** Must equal the contract's own hash; checked before broadcasting. */
export function signingHash(t: EthTxArgs): Hex {
  return keccak256(serializeTransaction(toViem(t)))
}

/** Attaches the MPC signature and broadcasts. Returns the Sepolia tx hash. */
export async function broadcast(t: EthTxArgs, mpc: unknown): Promise<Hex> {
  const rsv = csUtils.cryptography.toRSV(mpc as MPCSignature)
  const v = rsv.v >= 27 ? rsv.v - 27 : rsv.v
  const signed = serializeTransaction(toViem(t), {
    r: `0x${rsv.r.padStart(64, '0')}`,
    s: `0x${rsv.s.padStart(64, '0')}`,
    yParity: v,
  })
  return client.sendRawTransaction({ serializedTransaction: signed })
}

export const balanceOf = (address: Hex) => client.getBalance({ address })

// ---- ERC-20 tokens (for heirs moving what they inherited)

/** Common Sepolia test tokens; heirs can add any other token by address. */
export const KNOWN_TOKENS: { symbol: string; address: Hex; decimals: number }[] = [
  { symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', decimals: 6 },
  { symbol: 'LINK', address: '0x779877A7B0D9E8603169DdbD7836e478b4624789', decimals: 18 },
  { symbol: 'WETH', address: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14', decimals: 18 },
]

export interface TokenBalance { symbol: string; address: Hex; decimals: number; balance: bigint }

export async function tokenInfo(address: Hex): Promise<{ symbol: string; address: Hex; decimals: number }> {
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract({ address, abi: erc20Abi, functionName: 'decimals' }),
  ])
  return { symbol, address, decimals }
}

export async function tokenBalances(owner: Hex, tokens = KNOWN_TOKENS): Promise<TokenBalance[]> {
  const out = await Promise.all(tokens.map(async (t) => {
    const balance = await client.readContract({ address: t.address, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }).catch(() => 0n)
    return { ...t, balance }
  }))
  return out.filter((t) => t.balance > 0n)
}

export function transferData(to: Hex, amount: bigint): Hex {
  return encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] })
}

export const waitFor = (hash: Hex) => client.waitForTransactionReceipt({ hash })
