import { Account, KeyPair, KeyPairSigner, providers } from 'near-api-js'
import { actionCreators } from '@near-js/transactions'
import { PublicKey, type KeyPairString } from '@near-js/crypto'
import { FACTORY, KEY_ALLOWANCE, NEAR_RPC, TGAS } from './config'
import type { EthTxArgs } from './eth'

export const provider = new providers.JsonRpcProvider({ url: NEAR_RPC })

export async function view<T>(contractId: string, method: string, args: Record<string, unknown> = {}): Promise<T> {
  return (await provider.callFunction(contractId, method, args)) as T
}

export interface Wallet {
  path: string
  chain: 'Eth' | 'Sol' | 'Btc'
  heir: string
  daily_limit: string
}
export interface Trusted {
  chain: 'Eth' | 'Sol' | 'Btc'
  address: string
  label: string
}
export type Request =
  | { Eth: { tx: EthTxArgs } }
  | { Raw: { payload: string; domain_id: number; note: string } }
export interface Pending {
  id: number
  path: string
  request: Request
  created_at: string
  release_at: string
  approved_by: string | null
  status: 'Waiting' | 'Released' | 'Cancelled' | 'DuressHeld'
}
export interface PendingChange {
  id: number
  change: Record<string, unknown>
  apply_at: string
}
export interface WillState {
  owner: string
  phase: 'alive' | 'grace' | 'handed_over'
  now: string
  last_beat: string
  grace_at: string
  handover_at: string
  locked_until: string
  hold_secs: string
  alive_secs: string
  grace_secs: string
  wallets: Wallet[]
  guardians: string[]
  trusted: Trusted[]
  has_duress_key: boolean
  owner_key_count: number
  decoy_max: string
  spend: { path: string; spent_today: string; limit: string }[]
  pending: Pending[]
  changes: PendingChange[]
  demo: boolean
}

export const willOf = (owner: string) => view<string>(FACTORY, 'will_of', { owner })

export async function getState(will: string): Promise<WillState | null> {
  try {
    return await view<WillState>(will, 'get_state')
  } catch {
    return null
  }
}

export function publicKeyOf(secretKey: string): string {
  return KeyPair.fromString(secretKey as KeyPairString).getPublicKey().toString()
}

export function newKey() {
  const kp = KeyPair.fromRandom('ed25519')
  return { secretKey: kp.toString(), publicKey: kp.getPublicKey().toString() }
}

/** An account that signs with one of our own function-call keys: no wallet popups. */
export function keyAccount(accountId: string, secretKey: string) {
  return new Account(accountId, provider, KeyPairSigner.fromSecretKey(secretKey as KeyPairString))
}

export class ContractError extends Error {}

/** Calls a will method and returns its result (an MPC signature for sign calls). */
export async function call<T = unknown>(
  acc: Account,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  tgas = 300n,
): Promise<T> {
  try {
    const outcome = await acc.callFunctionRaw({
      contractId,
      methodName,
      args,
      gas: tgas * TGAS,
      deposit: 0n,
    })
    return providers.getTransactionLastResult(outcome) as T
  } catch (e) {
    throw new ContractError(readableError(e))
  }
}

/** Pulls the contract's panic message out of a NEAR error. */
export function readableError(e: unknown): string {
  const s = e instanceof Error ? e.message : JSON.stringify(e)
  const m = s.match(/Smart contract panicked: ([^"\\]+)/) ?? s.match(/panicked at [^:]+:\s*([^"\\]+)/)
  return (m ? m[1] : s).trim()
}

// ---- wallet transactions (one-time setup, signed in the user's NEAR wallet) ----

export function addFunctionKey(publicKey: string, receiverId: string) {
  return actionCreators.addKey(PublicKey.fromString(publicKey), actionCreators.functionCallAccessKey(receiverId, [], KEY_ALLOWANCE))
}

export function createWillAction(args: Record<string, unknown>, deposit: bigint) {
  return actionCreators.functionCall('create_will', { args }, 250n * TGAS, deposit)
}

/** Storage the factory asks for: the will's code size plus a little for its state. */
export async function willDeposit(): Promise<bigint> {
  const c = await view<{ min_deposit: string }>(FACTORY, 'get_config')
  return BigInt(c.min_deposit)
}

export function recoverKeyAction(publicKey: string) {
  return actionCreators.functionCall('recover_key', { key: publicKey }, 50n * TGAS, 0n)
}

export const nsToMs = (ns: string | number | bigint) => Number(BigInt(ns) / 1_000_000n)
