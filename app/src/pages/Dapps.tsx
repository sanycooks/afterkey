import { useEffect, useState } from 'react'
import { formatEther, type Hex } from 'viem'
import { short } from '../components/Chrome'
import { EXPLORER_ETH, WALLET_PATHS } from '../lib/config'
import { broadcast, buildTx, maxFee, signingHash, type EthTxArgs } from '../lib/eth'
import { call, view, type keyAccount, type WillState } from '../lib/near'
import {
  approveProposal, disconnect, rejectProposal, respond, respondError, walletKit, type WalletKitTypes,
} from '../lib/walletconnect'
import { F } from './Setup'

type Route = 'instant' | 'trusted' | 'over_limit' | 'contract_call' | 'locked' | 'handed_over'
interface Session { topic: string; name: string; url: string }

/** "Use in any dApp": WalletConnect, with every request going through the will's rules. */
export function Dapps({ acc, will, from, state, duress, heir = false, onResult }: {
  acc: ReturnType<typeof keyAccount>
  will: string
  from: Hex
  state: WillState
  duress: boolean
  /** Heirs sign with heir_sign: after the handover there are no limits or holds. */
  heir?: boolean
  onResult: (r: { ok: boolean; text: string; link?: string }) => void
}) {
  const [uri, setUri] = useState('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [proposal, setProposal] = useState<WalletKitTypes.SessionProposal | null>(null)
  const [req, setReq] = useState<WalletKitTypes.SessionRequest | null>(null)
  const [tx, setTx] = useState<EthTxArgs | null>(null)
  const [route, setRoute] = useState<Route | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    let cleanup = () => {}
    walletKit().then((kit) => {
      if (!alive) return
      const refresh = () =>
        setSessions(Object.values(kit.getActiveSessions()).map((s) => ({
          topic: s.topic, name: s.peer.metadata.name, url: s.peer.metadata.url,
        })))
      const onProposal = (p: WalletKitTypes.SessionProposal) => setProposal(p)
      const onRequest = (r: WalletKitTypes.SessionRequest) => setReq(r)
      kit.on('session_proposal', onProposal)
      kit.on('session_request', onRequest)
      kit.on('session_delete', refresh)
      refresh()
      cleanup = () => {
        kit.off('session_proposal', onProposal)
        kit.off('session_request', onRequest)
        kit.off('session_delete', refresh)
      }
    }).catch((e) => onResult({ ok: false, text: `WalletConnect didn't start: ${e?.message ?? e}` }))
    return () => { alive = false; cleanup() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Prepare the transaction as soon as a request arrives, so the user sees exactly what it does.
  useEffect(() => {
    setTx(null)
    setRoute(null)
    if (!req || req.params.request.method !== 'eth_sendTransaction') return
    const p = (req.params.request.params as Record<string, string>[])[0]
    ;(async () => {
      try {
        let t = await buildTx(from, p.to as Hex, BigInt(p.value ?? '0x0'), ((p.data ?? p.input) || '0x') as Hex)
        if (duress) {
          const room = BigInt(state.decoy_max) - maxFee(t)
          t = { ...t, value: String(BigInt(t.value) > room ? (room > 0n ? room : 0n) : BigInt(t.value)) }
          setTx(t)
          setRoute('instant')
          return
        }
        setTx(t)
        setRoute(heir ? 'instant' : await view<Route>(will, 'classify_eth', { path: WALLET_PATHS.eth, tx: t }))
      } catch (e) {
        onResult({ ok: false, text: `Couldn't prepare the dApp's transaction: ${e instanceof Error ? e.message : e}` })
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req])

  async function pair() {
    setBusy(true)
    try {
      const kit = await walletKit()
      await kit.pair({ uri: uri.trim() })
      setUri('')
    } catch (e) {
      onResult({ ok: false, text: `Couldn't connect: ${e instanceof Error ? e.message : e}` })
    } finally {
      setBusy(false)
    }
  }

  async function acceptProposal() {
    if (!proposal) return
    try {
      await approveProposal(proposal, from)
      const kit = await walletKit()
      setSessions(Object.values(kit.getActiveSessions()).map((s) => ({ topic: s.topic, name: s.peer.metadata.name, url: s.peer.metadata.url })))
      onResult({ ok: true, text: `Connected to ${proposal.params.proposer.metadata.name}` })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      onResult({ ok: false, text: msg.includes('chain') ? 'This dApp needs a network Afterkey doesn\'t support yet. Afterkey runs on Sepolia testnet.' : msg })
      await rejectProposal(proposal).catch(() => {})
    }
    setProposal(null)
  }

  async function sendNow() {
    if (!req || !tx) return
    setBusy(true)
    try {
      const h = await view<string>(will, 'eth_signing_hash', { tx })
      if (`0x${h}` !== signingHash(tx)) throw new Error('Hash mismatch between app and contract. Not sending.')
      const sig = heir
        ? await call<unknown>(acc, will, 'heir_sign', { path: WALLET_PATHS.eth, payload: h, domain_id: 0 })
        : await call<unknown>(acc, will, 'sign_eth', { path: WALLET_PATHS.eth, tx })
      if (typeof sig === 'string' && sig.startsWith('queued:')) {
        await respondError(req, 'Held by Afterkey')
        onResult({ ok: true, text: 'Sent ✓' })
      } else {
        const hash = await broadcast(tx, sig)
        await respond(req, hash)
        onResult({ ok: true, text: 'Sent from the dApp ✓', link: `${EXPLORER_ETH}/tx/${hash}` })
      }
      setReq(null)
    } catch (e) {
      onResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  async function hold() {
    if (!req || !tx) return
    setBusy(true)
    try {
      const id = await call<string>(acc, will, 'schedule_eth', { path: WALLET_PATHS.eth, tx }, 30n)
      await respondError(req, `Held by Afterkey as request #${id}. It is released after the hold or when a guardian approves.`)
      onResult({ ok: true, text: `Held as #${id}. A guardian can approve it now, or it's released after the hold.` })
      setReq(null)
    } catch (e) {
      onResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  async function reject(msg = 'Rejected in Afterkey') {
    if (!req) return
    await respondError(req, msg, 4001).catch(() => {})
    setReq(null)
  }

  const method = req?.params.request.method
  const dappName = req ? sessions.find((s) => s.topic === req.topic)?.name ?? 'A dApp' : ''

  return (
    <div className="card plain">
      <div className="row between center">
        <b style={{ fontSize: 18 }}>Use in any dApp</b>
        <span className="mono muted" style={{ fontSize: 12 }}>WalletConnect · Sepolia</span>
      </div>
      <span className="hint">
        {heir
          ? 'Withdraw positions, claim airdrops, swap. On the dApp, choose WalletConnect, copy its connection link, and paste it here.'
          : "On the dApp, choose WalletConnect, copy its connection link, and paste it here. Its transactions follow your will's rules: contract calls wait for the hold unless the contract is a trusted address or a guardian approves."}
      </span>
      <div className="row" style={{ alignItems: 'flex-end' }}>
        <F label="Connection link (starts with wc:)" value={uri} set={setUri} ph="wc:…" />
        <button className="btn solid" disabled={busy || !uri.startsWith('wc:')} onClick={pair}>Connect</button>
      </div>

      {sessions.map((s) => (
        <div key={s.topic} className="row between center hr" style={{ padding: '8px 0', fontSize: 14 }}>
          <span><b>{s.name}</b> <span className="mono muted">{s.url}</span></span>
          <button className="btn" style={{ minHeight: 34 }} onClick={() => disconnect(s.topic).then(() => setSessions((x) => x.filter((y) => y.topic !== s.topic)))}>Disconnect</button>
        </div>
      ))}

      {proposal && (
        <div className="card fade-in" style={{ borderColor: 'var(--accent-ink)' }}>
          <b>{proposal.params.proposer.metadata.name} wants to connect</b>
          <span className="mono muted" style={{ fontSize: 13 }}>{proposal.params.proposer.metadata.url}</span>
          <span className="hint">It will see your ETH address and can ask you to send transactions. It can't move anything without you.</span>
          <div className="row">
            <button className="btn accent" onClick={acceptProposal}>Connect</button>
            <button className="btn" onClick={() => rejectProposal(proposal).finally(() => setProposal(null))}>Reject</button>
          </div>
        </div>
      )}

      {req && method !== 'eth_sendTransaction' && (
        <div className="card fade-in" style={{ borderColor: 'var(--amber)' }}>
          <b>{dappName} asks you to sign a message ({method})</b>
          <span className="hint">
            Message signing isn't supported yet: the will can only sign transactions it can read. Most dApps still work
            without it; a few use it to log in.
          </span>
          <div><button className="btn" onClick={() => reject('Afterkey does not sign messages yet')}>Decline</button></div>
        </div>
      )}

      {req && method === 'eth_sendTransaction' && (
        <div className="card fade-in" style={{ borderColor: 'var(--accent-ink)' }}>
          <b>{dappName} wants to send a transaction</b>
          {!tx ? (
            <span className="muted">Reading it…</span>
          ) : (
            <>
              <div className="col mono" style={{ gap: 6, fontSize: 13 }}>
                <span>to {short(tx.to, 10)}</span>
                <span>value {formatEther(BigInt(tx.value))} ETH · max fee {formatEther(maxFee(tx))} ETH</span>
                <span>{tx.data === '0x' ? 'plain transfer' : `contract call · ${(tx.data.length - 2) / 2} bytes of data`}</span>
              </div>
              {(route === 'instant' || route === 'trusted') && (
                <div className="row center">
                  <span className="ok">{heir ? 'Inherited wallet: you can sign anything.' : route === 'trusted' ? 'Trusted contract: instant.' : 'Inside your daily limit: instant.'}</span>
                  <button className="btn accent" disabled={busy} onClick={sendNow}>{busy ? 'Signing…' : 'Approve and send'}</button>
                  <button className="btn" disabled={busy} onClick={() => reject()}>Reject</button>
                </div>
              )}
              {(route === 'over_limit' || route === 'contract_call') && (
                <div className="col" style={{ gap: 10 }}>
                  <span className="err">
                    {route === 'contract_call'
                      ? "This calls a contract that isn't trusted, so it can't go out instantly."
                      : "This is over today's limit."}{' '}
                    Hold it: a guardian can approve it now, or it's released after the hold. To make a protocol instant, add its contract as a trusted address in Safety.
                  </span>
                  <div className="row">
                    <button className="btn accent" disabled={busy} onClick={hold}>Hold it</button>
                    <button className="btn" disabled={busy} onClick={() => reject()}>Reject</button>
                  </div>
                </div>
              )}
              {route === 'locked' && <div className="err">Locked. Only a guardian can lift it early.</div>}
            </>
          )}
        </div>
      )}
    </div>
  )
}
