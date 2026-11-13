import { useEffect, useMemo, useState } from 'react'
import { formatEther, parseEther, type Hex } from 'viem'
import { Countdown, Pulse, short } from '../components/Chrome'
import { EXPLORER_ETH, FACTORY, WALLET_PATHS, telegramLink } from '../lib/config'
import { balanceOf, broadcast, buildTx, deriveEthAddress, maxFee, signingHash } from '../lib/eth'
import { addFunctionKey, call, keyAccount, newKey, nsToMs, willOf } from '../lib/near'
import { useNow } from '../lib/prefs'
import { chainNowMs, useWill } from '../lib/useWill'
import { loadRoleKey, saveRoleKey } from '../lib/vault'
import { sendWithWallet } from '../lib/wallet'
import { F } from './Setup'
import { describeChange } from './Owner'

/** Pick a will by its owner's account (or the will account itself). */
function WillPicker({ onPick, hint }: { onPick: (will: string) => void; hint: string }) {
  const [v, setV] = useState(new URLSearchParams(location.hash.split('?')[1] ?? '').get('will') ?? '')
  const [err, setErr] = useState('')
  async function go() {
    setErr('')
    const s = v.trim()
    try {
      onPick(s.endsWith(`.${FACTORY}`) ? s : await willOf(s))
    } catch {
      setErr("Couldn't find that will")
    }
  }
  return (
    <form className="col" style={{ maxWidth: 520, gap: 12 }} onSubmit={(e) => { e.preventDefault(); go() }}>
      <F label="The owner's NEAR account" value={v} set={setV} ph="alice.testnet" />
      <span className="hint">{hint}</span>
      {err && <div className="err">{err}</div>}
      <div><button className="btn solid" disabled={!v}>Open</button></div>
    </form>
  )
}

/** Adds a function-call key for this will to the user's account, once, so later actions need no wallet popups. */
function useRoleKey(account: string, will: string | null) {
  const [key, setKey] = useState<string | null>(null)
  useEffect(() => setKey(will ? loadRoleKey(account, will) : null), [account, will])
  async function link() {
    if (!will) return
    const k = newKey()
    saveRoleKey(account, will, k.secretKey)
    await sendWithWallet([{ receiverId: account, actions: [addFunctionKey(k.publicKey, will)] }])
    setKey(k.secretKey)
  }
  return { key, link }
}

// ------------------------------------------------------------------ guardian

export function Guardian({ account }: { account: string }) {
  const [will, setWill] = useState<string | null>(null)
  const { state, refresh, fetchedAt } = useWill(will)
  const now = useNow()
  const { key, link } = useRoleKey(account, will)
  const acc = useMemo(() => (key ? keyAccount(account, key) : null), [account, key])
  const [msg, setMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null)

  if (!will) return <Page title="Guarding a will"><WillPicker onPick={setWill} hint="You'll see this owner's held transfers and can approve or cancel them." /></Page>
  if (state === undefined) return <Page title="Guarding a will"><p className="muted">Loading…</p></Page>
  if (state === null) return <Page title="Guarding a will"><div className="err">No will at {will}.</div></Page>
  if (!state.guardians.includes(account)) return <Page title="Guarding a will"><div className="err">{account} isn't a guardian of {state.owner}'s will.</div></Page>

  const chainNow = chainNowMs(state, fetchedAt, now)
  const locked = nsToMs(state.locked_until) > chainNow
  async function run(label: string, fn: () => Promise<{ text: string; link?: string } | void>) {
    setMsg({ ok: true, text: `${label}…` })
    try {
      const r = await fn()
      setMsg({ ok: true, text: r?.text ?? `${label}: done`, link: r?.link })
      refresh()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Page title={`Guarding ${state.owner}`}>
      {msg && <div className={msg.ok ? 'ok' : 'err'}>{msg.text} {msg.link && <a href={msg.link} target="_blank" rel="noreferrer">view →</a>}</div>}
      {locked && (
        <div className="card plain" style={{ borderColor: 'var(--red)' }}>
          <b className="red">Locked by the duress password</b>
          <p className="sub" style={{ margin: 0 }}>
            {state.owner} used their duress password. They may be in danger right now. Check on them in person before
            doing anything. Lifting the lock lets them send again.
          </p>
          <div className="row center">
            <span className="mono amber">unlocks by itself in <Countdown ms={nsToMs(state.locked_until) - chainNow} /></span>
            <button className="btn" disabled={!acc} onClick={() => run('Lifting lockdown', () => call(acc!, will, 'lift_lockdown', {}, 30n).then(() => undefined))}>Lift lockdown</button>
          </div>
        </div>
      )}
      {!acc && (
        <div className="card plain">
          <b>Link this device as a guardian</b>
          <span className="hint">One wallet approval. After that, approving and cancelling happen here without popups.</span>
          <div><button className="btn accent" onClick={() => link().catch((e) => setMsg({ ok: false, text: String(e) }))}>Link</button></div>
        </div>
      )}
      <a className="mono" style={{ fontSize: 13 }} href={telegramLink('guardian', state.owner)} target="_blank" rel="noreferrer">
        Get guardian alerts on Telegram, including duress →
      </a>
      <div className="card plain">
        <b>Held transfers</b>
        {state.pending.length === 0 && <span className="muted">Nothing waiting.</span>}
        {state.pending.map((p) => {
          const eth = 'Eth' in p.request ? p.request.Eth.tx : null
          return (
            <div key={p.id} className="col hr" style={{ padding: '10px 0', gap: 8 }}>
              <div className="row between center">
                <span className="mono" style={{ fontSize: 14 }}>#{p.id} · {eth ? `${formatEther(BigInt(eth.value))} ETH → ${short(eth.to)}` : `raw request: ${'Raw' in p.request ? p.request.Raw.note : ''}`}</span>
                {p.status === 'DuressHeld' ? <b className="red mono" style={{ fontSize: 13 }}>made under duress</b> : <span className="mono amber" style={{ fontSize: 13 }}>releases in <Countdown ms={nsToMs(p.release_at) - chainNow} /></span>}
              </div>
              {p.status === 'DuressHeld' && <span className="hint red">This was requested with the duress password. Approving would hand the money to whoever forced it.</span>}
              <div className="row">
                <button className="btn accent" disabled={!acc} onClick={() => run('Approving', async () => {
                  const sig = await call(acc!, will, 'approve', { id: String(p.id) })
                  if (!eth) return { text: 'Approved and signed' }
                  const hash = await broadcast(eth, sig)
                  return { text: 'Approved and sent ✓', link: `${EXPLORER_ETH}/tx/${hash}` }
                })}>Approve now</button>
                <button className="btn danger" disabled={!acc} onClick={() => run('Cancelling', () => call(acc!, will, 'cancel', { id: String(p.id) }, 30n).then(() => undefined))}>Cancel</button>
              </div>
            </div>
          )
        })}
      </div>
      {state.changes.length > 0 && (
        <div className="card plain">
          <b>Settings changes waiting</b>
          <span className="hint">A new app key you didn't expect could mean someone else is trying to take over. Cancel it if in doubt.</span>
          {state.changes.map((c) => (
            <div key={c.id} className="row between center hr" style={{ padding: '8px 0' }}>
              <span className="mono" style={{ fontSize: 13 }}>#{c.id} · {describeChange(c.change)}</span>
              <span className="row center">
                <span className="mono amber" style={{ fontSize: 13 }}><Countdown ms={nsToMs(c.apply_at) - chainNow} /></span>
                <button className="btn danger" disabled={!acc} onClick={() => run('Blocking change', () => call(acc!, will, 'cancel_change', { id: String(c.id) }, 30n).then(() => undefined))}>Block</button>
              </span>
            </div>
          ))}
        </div>
      )}
    </Page>
  )
}

// ------------------------------------------------------------------ heir

export function Heir({ account }: { account: string }) {
  const [will, setWill] = useState<string | null>(null)
  const { state, refresh, fetchedAt } = useWill(will)
  const now = useNow()
  const { key, link } = useRoleKey(account, will)
  const acc = useMemo(() => (key ? keyAccount(account, key) : null), [account, key])
  const [addr, setAddr] = useState<Hex | null>(null)
  const [bal, setBal] = useState<bigint | null>(null)
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null)

  const ethWallet = state?.wallets.find((w) => w.path === WALLET_PATHS.eth && w.heir === account)
  useEffect(() => {
    if (!will || !ethWallet) return
    deriveEthAddress(will, WALLET_PATHS.eth).then(setAddr)
  }, [will, ethWallet])
  useEffect(() => {
    if (!addr) return
    const load = () => balanceOf(addr).then(setBal).catch(() => {})
    load()
    const t = setInterval(load, 8000)
    return () => clearInterval(t)
  }, [addr])

  if (!will) return <Page title="Inheriting"><WillPicker onPick={setWill} hint="Enter the account of the person who named you as their heir." /></Page>
  if (state === undefined) return <Page title="Inheriting"><p className="muted">Loading…</p></Page>
  if (state === null) return <Page title="Inheriting"><div className="err">No will at {will}.</div></Page>
  const mine = state.wallets.filter((w) => w.heir === account)
  if (!mine.length) return <Page title="Inheriting"><div className="err">{account} isn't an heir in {state.owner}'s will.</div></Page>

  const chainNow = chainNowMs(state, fetchedAt, now)
  const handoverAt = nsToMs(state.handover_at)
  if (chainNow < handoverAt) {
    return (
      <Page title={`${state.owner}'s will`}>
        <p className="sub" style={{ margin: 0 }}>You're the heir of their {mine.map((w) => w.chain.toUpperCase()).join(', ')} wallet{mine.length > 1 ? 's' : ''}. Nothing is yours to touch while they're active.</p>
        <Pulse height={80} flat={chainNow >= nsToMs(state.grace_at)} color={chainNow >= nsToMs(state.grace_at) ? 'var(--amber)' : 'var(--accent-ink)'} />
        <div className="mono" style={{ fontSize: 13 }}>If they stay silent, handover in</div>
        <div className="mono" style={{ fontSize: 40, fontWeight: 700 }}><Countdown ms={handoverAt - chainNow} /></div>
      </Page>
    )
  }

  async function send(all: boolean) {
    if (!acc || !addr || !will) return
    setMsg({ ok: true, text: 'Signing as heir…' })
    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('Enter a 0x… ETH address')
      let t = await buildTx(addr, to as Hex, all ? 0n : parseEther(amount || '0'))
      if (all) {
        const b = await balanceOf(addr)
        t = { ...t, value: String(b - maxFee(t) > 0n ? b - maxFee(t) : 0n) }
      }
      const sig = await call(acc, will, 'heir_sign', { path: WALLET_PATHS.eth, payload: signingHash(t).slice(2), domain_id: 0 })
      const hash = await broadcast(t, sig)
      setMsg({ ok: true, text: 'Sent from the inherited wallet ✓', link: `${EXPLORER_ETH}/tx/${hash}` })
      refresh()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Page title={`${state.owner} left you ${mine.length === 1 ? 'a wallet' : `${mine.length} wallets`}.`}>
      <p className="sub" style={{ margin: 0, lineHeight: 1.6 }}>
        Same addresses, same history. Everything inside is yours now, including anything that arrives later. Only you
        can sign from them.
      </p>
      {msg && <div className={msg.ok ? 'ok' : 'err'}>{msg.text} {msg.link && <a href={msg.link} target="_blank" rel="noreferrer">view →</a>}</div>}
      {!acc && (
        <div className="card plain">
          <b>Link this device as heir</b>
          <span className="hint">One wallet approval, then you sign from the inherited wallets here.</span>
          <div><button className="btn accent" onClick={() => link().catch((e) => setMsg({ ok: false, text: String(e) }))}>Link</button></div>
        </div>
      )}
      {ethWallet && (
        <div className="card plain">
          <div className="row between center">
            <b className="display" style={{ fontSize: 26 }}>ETH</b>
            <span className="mono" style={{ fontSize: 13 }}>{addr ? <a href={`${EXPLORER_ETH}/address/${addr}`} target="_blank" rel="noreferrer">{addr}</a> : '…'}</span>
          </div>
          <div className="row between hr" style={{ padding: '8px 0' }}><span>Balance (Sepolia)</span><span className="mono">{bal === null ? '…' : `${formatEther(bal)} ETH`}</span></div>
          <div className="row">
            <F label="Send to" value={to} set={setTo} ph="0x… your own wallet" />
            <F label="Amount (ETH)" value={amount} set={setAmount} ph="0.01" />
          </div>
          <div className="row">
            <button className="btn solid" disabled={!acc || !to || !amount} onClick={() => send(false)}>Sign from this wallet</button>
            <button className="btn" disabled={!acc || !to} onClick={() => send(true)}>Move everything to this address</button>
          </div>
        </div>
      )}
      {mine.filter((w) => w.chain !== 'Eth').map((w) => (
        <div key={w.path} className="card plain row between center" style={{ flexDirection: 'row' }}>
          <b>{w.chain.toUpperCase()} wallet</b>
          <span className="hint">Yours. Signing from it in the app comes next.</span>
        </div>
      ))}
    </Page>
  )
}

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="col" style={{ gap: 18, padding: '40px 0 80px', maxWidth: 900 }}>
      <h1 className="display" style={{ margin: 0, fontSize: 'clamp(28px, 4vw, 40px)' }}>{title}</h1>
      {children}
    </div>
  )
}
