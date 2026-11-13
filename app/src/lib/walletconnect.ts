// WalletConnect: lets any dApp talk to the Afterkey wallet as if it were MetaMask.
// The dApp's transaction requests land here, go through the will's rules
// (instant, trusted, or held), get signed by NEAR's MPC network, and are broadcast.
import type { WalletKitTypes } from '@reown/walletkit'
import { REOWN_PROJECT_ID, SEPOLIA_CHAIN_ID } from './config'

type Kit = Awaited<ReturnType<typeof import('@reown/walletkit').WalletKit.init>>
let kitP: Promise<Kit> | null = null

/** Loaded on demand so the landing page stays light. */
export function walletKit(): Promise<Kit> {
  kitP ??= (async () => {
    const [{ Core }, { WalletKit }] = await Promise.all([import('@walletconnect/core'), import('@reown/walletkit')])
    return WalletKit.init({
      core: new Core({ projectId: REOWN_PROJECT_ID }),
      metadata: {
        name: 'Afterkey',
        description: 'A seedless wallet with a will built in',
        url: location.origin,
        icons: [`${location.origin}/favicon.svg`],
      },
    })
  })()
  return kitP
}

export const CHAIN = `eip155:${SEPOLIA_CHAIN_ID}`
const METHODS = ['eth_sendTransaction', 'personal_sign', 'eth_sign', 'eth_signTypedData', 'eth_signTypedData_v4']

export async function approveProposal(p: WalletKitTypes.SessionProposal, address: string) {
  const [{ buildApprovedNamespaces }, kit] = await Promise.all([import('@walletconnect/utils'), walletKit()])
  const namespaces = buildApprovedNamespaces({
    proposal: p.params,
    supportedNamespaces: {
      eip155: { chains: [CHAIN], methods: METHODS, events: ['accountsChanged', 'chainChanged'], accounts: [`${CHAIN}:${address}`] },
    },
  })
  return kit.approveSession({ id: p.id, namespaces })
}

export async function rejectProposal(p: WalletKitTypes.SessionProposal) {
  const [{ getSdkError }, kit] = await Promise.all([import('@walletconnect/utils'), walletKit()])
  return kit.rejectSession({ id: p.id, reason: getSdkError('USER_REJECTED') })
}

export async function respond(r: WalletKitTypes.SessionRequest, result: unknown) {
  const kit = await walletKit()
  return kit.respondSessionRequest({ topic: r.topic, response: { id: r.id, jsonrpc: '2.0', result } })
}

export async function respondError(r: WalletKitTypes.SessionRequest, message: string, code = 5000) {
  const kit = await walletKit()
  return kit.respondSessionRequest({ topic: r.topic, response: { id: r.id, jsonrpc: '2.0', error: { code, message } } })
}

export async function disconnect(topic: string) {
  const [{ getSdkError }, kit] = await Promise.all([import('@walletconnect/utils'), walletKit()])
  return kit.disconnectSession({ topic, reason: getSdkError('USER_DISCONNECTED') })
}

export type { WalletKitTypes }
