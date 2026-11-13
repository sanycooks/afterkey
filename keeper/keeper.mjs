// Afterkey keeper (optional).
//
// Telegram alerts run on Cloudflare Workers (see alerts/), with no server needed.
// This keeper is the one optional extra: when a scheduled transfer's hold ends,
// it calls `execute` and broadcasts the signed transaction, so the transfer goes
// out by itself instead of waiting for someone to tap "Send now" in the app.
// It can only push forward what the contract already allows; it can't move
// anything on its own. Run it anywhere that stays on: a VPS, a home server, a
// free-tier cloud VM.

import { Account, KeyPairSigner, providers } from 'near-api-js'
import { createPublicClient, http, serializeTransaction } from 'viem'
import { sepolia } from 'viem/chains'
import { utils as csUtils } from 'chainsig.js'

const env = process.env
const NEAR_RPC = env.NEAR_RPC ?? 'https://rpc.testnet.near.org'
const SEPOLIA_RPC = env.SEPOLIA_RPC ?? 'https://ethereum-sepolia-rpc.publicnode.com'
/** Where to learn which wills to look after: the alerts worker's /wills, or a comma list in WILLS. */
const ALERTS_URL = env.ALERTS_URL
const POLL_MS = Number(env.POLL_MS ?? 15_000)
if (!env.KEEPER_ACCOUNT || !env.KEEPER_KEY) throw new Error('Set KEEPER_ACCOUNT and KEEPER_KEY')
if (!ALERTS_URL && !env.WILLS) throw new Error('Set ALERTS_URL (your alerts worker) or WILLS')

const near = new providers.JsonRpcProvider({ url: NEAR_RPC })
const eth = createPublicClient({ chain: sepolia, transport: http(SEPOLIA_RPC) })
const keeper = new Account(env.KEEPER_ACCOUNT, near, KeyPairSigner.fromSecretKey(env.KEEPER_KEY))
const ms = (ns) => Number(BigInt(ns) / 1_000_000n)

async function wills() {
  if (env.WILLS) return env.WILLS.split(',').map((w) => w.trim()).filter(Boolean)
  return fetch(`${ALERTS_URL.replace(/\/$/, '')}/wills`).then((r) => r.json())
}

async function keep(will, s, now) {
  for (const p of s.pending) {
    if (p.status !== 'Waiting' || ms(p.release_at) > now) continue
    try {
      const outcome = await keeper.callFunctionRaw({ contractId: will, methodName: 'execute', args: { id: String(p.id) }, gas: 300n * 10n ** 12n, deposit: 0n })
      const sig = providers.getTransactionLastResult(outcome)
      if ('Eth' in p.request) {
        const hash = await broadcast(p.request.Eth.tx, sig)
        console.log(`sent #${p.id} of ${will}: https://sepolia.etherscan.io/tx/${hash}`)
      }
    } catch (e) {
      console.error('execute failed', will, p.id, e.message)
    }
  }
  for (const c of s.changes) {
    if (ms(c.apply_at) > now) continue
    try {
      await keeper.callFunctionRaw({ contractId: will, methodName: 'apply_change', args: { id: String(c.id) }, gas: 30n * 10n ** 12n, deposit: 0n })
    } catch (e) {
      console.error('apply failed', will, c.id, e.message)
    }
  }
}

async function broadcast(t, mpc) {
  const rsv = csUtils.cryptography.toRSV(mpc)
  const v = rsv.v >= 27 ? rsv.v - 27 : rsv.v
  const tx = {
    type: 'eip1559', chainId: Number(t.chain_id), nonce: Number(t.nonce),
    maxPriorityFeePerGas: BigInt(t.max_priority_fee_per_gas), maxFeePerGas: BigInt(t.max_fee_per_gas),
    gas: BigInt(t.gas_limit), to: t.to, value: BigInt(t.value), data: t.data === '0x' ? undefined : t.data, accessList: [],
  }
  const signed = serializeTransaction(tx, { r: `0x${rsv.r.padStart(64, '0')}`, s: `0x${rsv.s.padStart(64, '0')}`, yParity: v })
  return eth.sendRawTransaction({ serializedTransaction: signed })
}

const sleep = (t) => new Promise((r) => setTimeout(r, t))

async function loop() {
  for (;;) {
    for (const will of await wills().catch(() => [])) {
      try {
        const s = await near.callFunction(will, 'get_state', {})
        if (s.phase !== 'handed_over' && s.locked_until === '0') await keep(will, s, ms(s.now))
      } catch (e) {
        console.error(will, e.message)
      }
    }
    await sleep(POLL_MS)
  }
}

console.log(`Afterkey keeper as ${env.KEEPER_ACCOUNT}`)
loop()
