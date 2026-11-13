import { createPublicClient, http, keccak256, serializeTransaction, type Hex } from 'viem'
import { sepolia } from 'viem/chains'
import { chainAdapters, contracts, utils as csUtils, type MPCSignature } from 'chainsig.js'
import { MPC, SEPOLIA_CHAIN_ID, SEPOLIA_RPC } from './config'

export const client = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) })

const csContract = new contracts.ChainSignatureContract({ networkId: 'testnet', contractId: MPC })
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
