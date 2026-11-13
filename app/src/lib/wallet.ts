import { setupWalletSelector, type WalletSelector } from '@near-wallet-selector/core'
import { setupModal } from '@near-wallet-selector/modal-ui'
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet'
import { setupMeteorWallet } from '@near-wallet-selector/meteor-wallet'
import '@near-wallet-selector/modal-ui/styles.css'
import type { Action } from '@near-js/transactions'
import { FACTORY } from './config'

let selectorP: Promise<WalletSelector> | null = null

export function selector(): Promise<WalletSelector> {
  selectorP ??= setupWalletSelector({
    network: 'testnet',
    modules: [setupMeteorWallet(), setupMyNearWallet()],
  })
  return selectorP
}

export async function openWalletModal() {
  const s = await selector()
  setupModal(s, { contractId: FACTORY }).show()
}

export async function activeAccount(): Promise<string | null> {
  const s = await selector()
  return s.store.getState().accounts.find((a) => a.active)?.accountId ?? null
}

export async function onAccountChange(cb: (id: string | null) => void) {
  const s = await selector()
  return s.store.observable.subscribe((st) => cb(st.accounts.find((a) => a.active)?.accountId ?? null))
}

export async function signOut() {
  const s = await selector()
  const w = await s.wallet()
  await w.signOut()
}

/** One-time setup transactions, approved in the user's NEAR wallet. */
export async function sendWithWallet(txs: { receiverId: string; actions: Action[] }[]) {
  const s = await selector()
  const w = await s.wallet()
  const signerId = (await activeAccount()) ?? undefined
  return w.signAndSendTransactions({ transactions: txs.map((t) => ({ signerId: signerId!, ...t })) })
}
