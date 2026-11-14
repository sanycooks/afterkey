import { useEffect, useMemo, useState } from 'react'
import { formatEther, parseEther, type Hex } from 'viem'
import { Countdown, Pulse, short } from '../components/Chrome'
import { EXPLORER_BTC, EXPLORER_ETH, EXPLORER_SOL, WALLET_PATHS, telegramLink } from '../lib/config'
import { btcWallet, solWallet, type ChainWallet } from '../lib/multichain'
import { balanceOf, broadcast, buildTx, deriveEthAddress, maxFee, signingHash, type EthTxArgs } from '../lib/eth'
import { addFunctionKey as addKey, call, keyAccount, newKey, nsToMs, recoverKeyAction, view, ContractError, type Pending, type WillState } from '../lib/near'
import { useNow } from '../lib/prefs'
import { chainNowMs, useWill } from '../lib/useWill'
import { createVault, unlock, type Unlocked } from '../lib/vault'
import { sendWithWallet } from '../lib/wallet'
import { F } from './Setup'
import { Dapps } from './Dapps'

// ------------------------------------------------------------------ unlock

export function Unlock({ account, onUnlock }: { account: string; onUnlock: (u: Unlocked) => void }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  async function go() {
    setBusy(true)
    setErr('')
    const u = await unlock(account, pw)
    setBusy(false)
    if (u) onUnlock(u)
    else setErr('Wrong password')
  }
  return (
    <div className="col" style={{ maxWidth: 420, padding: '80px 0', gap: 18 }}>
      <h1 className="display" style={{ margin: 0, fontSize: 32 }}>Unlock</h1>
      <p className="sub" style={{ margin: 0 }}>Enter your app password for {account}.</p>
      <form className="col" onSubmit={(e) => { e.preventDefault(); go() }}>
        <F label="App password" value={pw} set={setPw} type="password" />
        {err && <div className="err">{err}</div>}
        <button className="btn accent big" disabled={busy || !pw}>{busy ? 'Unlocking…' : 'Unlock'}</button>
      </form>
    </div>
  )
}

/** Device lost or browser cleared: ask for a new app key through the normal wallet. */
export function RecoverDevice({ account, will }: { account: string; will: string }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [sent, setSent] = useState(false)
  async function go() {
    if (pw.length < 8) return setErr('Use at least 8 characters')
    const k = newKey()
    await createVault(account, will, { secretKey: k.secretKey, password: pw })
    try {
      await sendWithWallet([
        { receiverId: account, actions: [addKey(k.publicKey, will)] },
        { receiverId: will, actions: [recoverKeyAction(k.publicKey)] },
      ])
      setSent(true)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    }
  }
  return (
    <div className="col" style={{ maxWidth: 560, padding: '60px 0', gap: 16 }}>
      <h1 className="display" style={{ margin: 0, fontSize: 32 }}>This device isn't linked</h1>
      <p className="sub" style={{ margin: 0, lineHeight: 1.6 }}>
        You have a will, but its app key isn't on this device. Request a new one: it becomes active after the hold
        period, and your guardians are told so they can stop it if it isn't you.
      </p>
      {sent ? (
        <div className="ok">Requested. It activates after the hold. Then unlock with the password you just set.</div>
      ) : (
        <>
          <F label="New app password" value={pw} set={setPw} type="password" />
          {err && <div className="err">{err}</div>}
          <button className="btn accent big" onClick={go}>Request a new app key</button>
        </>
      )}
    </div>
  )
}


// ------------------------------------------------------------------ dashboard

export function Dashboard({ account, will, me }: { account: string; will: string; me: Unlocked }) {
  const { state, refresh, fetchedAt } = useWill(will)
  const now = useNow()
  const acc = useMemo(() => keyAccount(account, me.secretKey), [account, me.secretKey])
  const duress = me.mode === 'duress'
  const [ethAddr, setEthAddr] = useState<Hex | null>(null)
  const [bal, setBal] = useState<bigint | null>(null)
  const [sol, setSol] = useState<ChainWallet | null>(null)
  const [btc, setBtc] = useState<ChainWallet | null>(null)
  const [toast, setToast] = useState<{ ok: boolean; text: string; link?: string } | null>(null)
  const [recover, setRecover] = useState(false)
  const [tab, setTab] = useState<'send' | 'dapps' | 'queue' | 'safety'>('send')
  const [preview, setPreview] = useState(false)
  const [flags, setFlags] = useState(() => ({
    tg: localStorage.getItem(`afterkey:tg:${account}`) === '1',
    invited: localStorage.getItem(`afterkey:invited:${account}`) === '1',
  }))
  const flag = (k: 'tg' | 'invited') => {
    localStorage.setItem(`afterkey:${k}:${account}`, '1')
    setFlags((f) => ({ ...f, [k]: true }))
  }

  useEffect(() => {
    deriveEthAddress(will, WALLET_PATHS.eth).then(setEthAddr).catch(() => setEthAddr(null))
    solWallet(will, WALLET_PATHS.sol).then(setSol).catch(() => setSol(null))
    btcWallet(will, WALLET_PATHS.btc).then(setBtc).catch(() => setBtc(null))
  }, [will])
  useEffect(() => {
    if (!ethAddr) return
    const load = () => balanceOf(ethAddr).then(setBal).catch(() => {})
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [ethAddr])

  if (!state) return <p className="muted" style={{ padding: 40 }}>Loading your will…</p>

  const chainNow = chainNowMs(state, fetchedAt, now)
  const graceAt = nsToMs(state.grace_at)
  const handoverAt = nsToMs(state.handover_at)
  const lockedUntil = nsToMs(state.locked_until)
  const locked = !duress && lockedUntil > chainNow
  const phase = chainNow >= handoverAt ? 'handed_over' : chainNow >= graceAt ? 'grace' : 'alive'
  const color = phase === 'alive' ? 'var(--accent-ink)' : 'var(--amber)'
  const ethWallet = state.wallets.find((w) => w.path === WALLET_PATHS.eth)
  const spend = state.spend.find((s) => s.path === WALLET_PATHS.eth)
  const pending = state.pending.filter((p) => !(duress && p.status === 'DuressHeld'))

  // What a forced send could take right now: what's left of today's limit, nothing while locked.
  const limit = BigInt(ethWallet?.daily_limit ?? '0')
  const left = limit - BigInt(spend?.spent_today ?? '0')
  const balance = bal ?? 0n
  const available = locked ? 0n : left <= 0n ? 0n : left < balance ? left : balance
  const protectedWei = balance - available
  const frozen = limit === 0n && state.trusted.length === 0

  // Heirs grouped: "ETH + SOL wallets → amina.testnet"
  const byHeir = new Map<string, string[]>()
  for (const w of state.wallets) byHeir.set(w.heir, [...(byHeir.get(w.heir) ?? []), w.chain.toUpperCase()])

  const checks: [string, boolean][] = [
    ['Heirs set', state.wallets.length > 0],
    ['Guardian set', state.guardians.length > 0],
    ['Duress password', state.has_duress_key],
    ['Telegram alerts', flags.tg],
    ['Heir invited', flags.invited],
  ]
  const missing = checks.filter(([, ok]) => !ok).length

  async function run(label: string, fn: () => Promise<{ text: string; link?: string } | void>) {
    setToast({ ok: true, text: `${label}…` })
    try {
      const r = await fn()
      setToast(r ? { ok: true, ...r } : { ok: true, text: `${label}: done` })
      refresh()
    } catch (e) {
      setToast({ ok: false, text: explain(e instanceof Error ? e.message : String(e)) })
    }
  }

  function freeze() {
    run('Freezing', async () => {
      // Tightening applies at once in the contract; loosening it again waits for the hold.
      await call(acc, will, 'propose', { change: { SetDailyLimit: { path: WALLET_PATHS.eth, limit: '0' } } }, 30n)
      for (const t of state!.trusted) await call(acc, will, 'propose', { change: { RemoveTrusted: { address: t.address } } }, 30n)
      return { text: `Frozen ✓ Nothing big can leave. Undoing it takes ${fmtSecs(state!.hold_secs)}.` }
    })
  }

  if (recover) return <RecoverDevice account={account} will={will} />
  if (phase === 'handed_over') {
    return (
      <div className="col" style={{ padding: '60px 0', gap: 16, maxWidth: 640 }}>
        <h1 className="display" style={{ margin: 0, fontSize: 36, color: 'var(--orange)' }}>Handed over</h1>
        <p className="sub" style={{ margin: 0, lineHeight: 1.6 }}>
          No activity reached the contract for {fmtSecs(state.alive_secs)} plus {fmtSecs(state.grace_secs)} of grace.
          Your heirs now sign for these wallets. This can't be undone.
        </p>
      </div>
    )
  }

  const tabs: [typeof tab, string][] = [['send', 'Send'], ['dapps', 'Use in any dApp'], ['queue', `Waiting (${pending.length})`], ['safety', 'Safety settings']]
  const h2 = { margin: 0, fontSize: 20 }

  return (
    <div className="col" style={{ gap: 20, padding: '24px 0 80px' }}>
      {locked && (
        <div className="err" role="alert">
          Locked until {new Date(lockedUntil).toLocaleString()}. Only a guardian can lift it early.
        </div>
      )}
      {toast && (
        <div className={toast.ok ? 'ok' : 'err'} role="status">
          {toast.text}{' '}
          {toast.link && <a href={toast.link} target="_blank" rel="noreferrer">view on explorer →</a>}
          {!toast.ok && toast.text.includes("isn't registered") && (
            <button className="btn" style={{ marginLeft: 10, minHeight: 34 }} onClick={() => setRecover(true)}>Request a new app key</button>
          )}
        </div>
      )}

      <div className="row between center" style={{ border: '1px solid var(--line)', padding: '14px 20px' }}>
        <span className="row center" style={{ gap: 12 }}>
          <span className="dot" style={{ color: missing ? 'var(--amber)' : 'var(--accent-ink)' }} />
          <b style={{ fontSize: 16 }}>{missing ? `Almost covered: ${missing} left` : "You're covered."}</b>
        </span>
        <span className="row mono sub" style={{ gap: 18, fontSize: 13 }}>
          {checks.map(([label, ok]) => (
            <span key={label}><span style={{ color: ok ? 'var(--accent-ink)' : 'var(--amber)' }}>{ok ? '✓' : '○'}</span> {label}</span>
          ))}
        </span>
      </div>

      <div className="row" style={{ gap: 20 }}>
        <section className="card grow" style={{ flex: '1 1 480px' }}>
          <div className="row between" style={{ alignItems: 'baseline' }}>
            <h2 className="display" style={h2}>If you disappear</h2>
            <span className="mono muted" style={{ fontSize: 12 }}>your will</span>
          </div>
          <div className="row center" style={{ gap: 16 }}>
            <div style={{ width: 170 }}><Pulse height={44} color={color} flat={phase === 'grace'} speed={3.6} /></div>
            <div>
              <div className="muted" style={{ fontSize: 13 }}>{phase === 'alive' ? 'Alive · grace starts in' : 'Grace period · heirs take over in'}</div>
              <div className="mono" style={{ fontSize: 26, fontWeight: 700, color: phase === 'grace' ? 'var(--amber)' : undefined }}>
                <Countdown ms={(phase === 'alive' ? graceAt : handoverAt) - chainNow} />
              </div>
            </div>
          </div>
          <div className="mono" style={{ display: 'flex', height: 26, fontSize: 11, fontWeight: 700, color: '#0a0b0a' }}>
            <div style={{ flex: 6, background: 'var(--accent)', padding: '0 8px', display: 'flex', alignItems: 'center' }}>{fmtSecs(state.alive_secs)}</div>
            <div style={{ flex: 2, background: 'var(--amber-fill)', padding: '0 6px', display: 'flex', alignItems: 'center' }}>{fmtSecs(state.grace_secs)} grace</div>
            <div style={{ flex: 2, background: 'var(--orange-fill)', padding: '0 6px', display: 'flex', alignItems: 'center' }}>heirs</div>
          </div>
          <div className="col" style={{ gap: 0 }}>
            {[...byHeir].map(([heir, chains]) => (
              <div key={heir} className="row between hr" style={{ padding: '10px 0', fontSize: 14 }}>
                <span>{chains.join(' + ')} wallet{chains.length > 1 ? 's' : ''}</span><span className="mono orange">{heir}</span>
              </div>
            ))}
          </div>
          <div className="row" style={{ gap: 10 }}>
            <button className="btn" style={{ borderColor: 'var(--text)' }} onClick={() => run('Check-in', () => call(acc, will, 'heartbeat', {}, 30n).then(() => undefined))}>Check in</button>
            <button className="btn" aria-expanded={preview} onClick={() => setPreview((p) => !p)}>See what your heir sees</button>
            <CopyLink label="Copy heir invite" url={`${location.origin}/#/app?heir=${account}`} onCopy={() => flag('invited')} />
          </div>
          {preview && (
            <div className="card fade-in" style={{ gap: 8 }}>
              <span className="mono orange" style={{ fontSize: 12 }}>WHAT YOUR HEIR SEES AFTER THE HANDOVER</span>
              <b>{account} left you {state.wallets.length} wallet{state.wallets.length > 1 ? 's' : ''}.</b>
              <span className="sub" style={{ fontSize: 14 }}>
                ETH {bal === null ? '' : `· ${Number(formatEther(bal)).toFixed(4)} ETH`}{sol?.balance != null ? ` · SOL ${sol.balance}` : ''}{btc?.balance != null ? ` · BTC ${btc.balance}` : ''}
              </span>
              <span className="sub" style={{ fontSize: 14 }}>They can move everything to their own wallet, or use these wallets in any dApp. Until then they see only the countdown.</span>
            </div>
          )}
        </section>

        <section className="card grow" style={{ flex: '1 1 480px' }}>
          <div className="row between" style={{ alignItems: 'baseline' }}>
            <h2 className="display" style={h2}>If you're forced</h2>
            <span className="mono muted" style={{ fontSize: 12 }}>kidnap protection</span>
          </div>
          <div className="row" style={{ gap: 24 }}>
            <div className="grow" style={{ flex: '1 1 160px' }}>
              <div className="muted" style={{ fontSize: 13 }}>Available now</div>
              <div className="mono ink" style={{ fontSize: 28, fontWeight: 700 }}>{bal === null ? '…' : `${trim(formatEther(available))} ETH`}</div>
            </div>
            <div className="grow" style={{ flex: '1 1 160px' }}>
              <div className="muted" style={{ fontSize: 13 }}>Protected ({fmtSecs(state.hold_secs)} hold)</div>
              <div className="mono" style={{ fontSize: 28, fontWeight: 700 }}>{bal === null ? '…' : `${trim(formatEther(protectedWei))} ETH`}</div>
            </div>
          </div>
          <div style={{ height: 10, background: 'var(--track)', display: 'flex' }}>
            <div style={{ width: `${balance > 0n ? Number((available * 1000n) / balance) / 10 : 0}%`, background: 'var(--accent-ink)', transition: 'width .6s' }} />
          </div>
          <div className="col" style={{ gap: 0 }}>
            <div className="row between hr" style={{ padding: '10px 0', fontSize: 14 }}>
              <span>Guardians</span><span className="mono">{state.guardians.join(' · ') || 'none yet'}</span>
            </div>
            <div className="row between hr" style={{ padding: '10px 0', fontSize: 14 }}>
              <span>Duress password</span><b className={state.has_duress_key ? 'ink' : 'muted'}>{state.has_duress_key ? 'set' : 'not set'}</b>
            </div>
          </div>
          <div className="row center" style={{ gap: 14 }}>
            {frozen ? (
              <span className="mono red" style={{ fontSize: 14, fontWeight: 700 }}>Frozen</span>
            ) : (
              <button className="btn big" style={{ background: 'var(--red)', borderColor: 'var(--red)', color: 'var(--on-red)' }} onClick={freeze}>Freeze now</button>
            )}
            <span className="sub" style={{ fontSize: 13 }}>
              {frozen ? `Raise the limit in Safety settings to unfreeze. It takes ${fmtSecs(state.hold_secs)}.` : `Nothing big can leave. Undoing it takes ${fmtSecs(state.hold_secs)}.`}
            </span>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <a className="btn" href={telegramLink('owner', account)} target="_blank" rel="noreferrer" onClick={() => flag('tg')}>Get Telegram alerts</a>
            <CopyLink label="Copy guardian invite" url={`${location.origin}/#/app?guard=${account}`} />
          </div>
        </section>
      </div>

      <div className="card plain" style={{ padding: 0, gap: 0 }}>
        <div className="table-row mono muted" style={{ gridTemplateColumns: '60px 1.5fr 1fr 1fr', fontSize: 11, padding: '12px 20px' }}>
          <span>chain</span><span>address</span><span>balance</span><span>heir</span>
        </div>
        <WalletRow chain="ETH" address={ethAddr} href={ethAddr ? `${EXPLORER_ETH}/address/${ethAddr}` : undefined}
          balance={bal === null ? null : `${trim(formatEther(bal))} ETH`} net="Sepolia" heir={ethWallet?.heir} />
        <WalletRow chain="SOL" address={sol?.address ?? null} href={sol ? EXPLORER_SOL(sol.address) : undefined}
          balance={sol?.balance == null ? null : `${sol.balance} SOL`} net="devnet" heir={state.wallets.find((w) => w.path === WALLET_PATHS.sol)?.heir} />
        <WalletRow chain="BTC" address={btc?.address ?? null} href={btc ? EXPLORER_BTC(btc.address) : undefined}
          balance={btc?.balance == null ? null : `${btc.balance} BTC`} net="testnet4" heir={state.wallets.find((w) => w.path === WALLET_PATHS.btc)?.heir} last />
      </div>

      <div className="col" style={{ gap: 16 }}>
        <nav className="row" style={{ gap: 2, borderBottom: '1px solid var(--line)' }} aria-label="Wallet actions">
          {tabs.map(([id, label]) => (
            <button key={id} className="btn" onClick={() => setTab(id)} aria-pressed={tab === id}
              style={{ border: 0, borderBottom: `2px solid ${tab === id ? 'var(--accent-ink)' : 'transparent'}`, fontFamily: "'Inter Tight', system-ui, sans-serif", fontSize: 14, fontWeight: tab === id ? 600 : 400, color: tab === id ? 'var(--text)' : 'var(--sub)' }}>
              {label}
            </button>
          ))}
        </nav>
        {tab === 'send' && ethAddr && ethWallet && (
          <SendPanel acc={acc} will={will} from={ethAddr} state={state} duress={duress} onResult={(r) => { setToast(r); refresh() }} />
        )}
        {tab === 'dapps' && ethAddr && (
          <Dapps acc={acc} will={will} from={ethAddr} state={state} duress={duress} onResult={(r) => { setToast(r); refresh() }} />
        )}
        {tab === 'queue' && (pending.length ? <Queue acc={acc} will={will} pending={pending} chainNow={chainNow} run={run} /> : <p className="muted" style={{ margin: 0 }}>Nothing waiting.</p>)}
        {tab === 'safety' && (
          <Safety acc={acc} will={will} state={state} chainNow={chainNow} spentWei={spend?.spent_today} limitWei={ethWallet?.daily_limit} run={run} duress={duress} />
        )}
      </div>
    </div>
  )
}

function WalletRow({ chain, address, href, balance, net, heir, last }: {
  chain: string; address: string | null; href?: string; balance: string | null; net: string; heir?: string; last?: boolean
}) {
  return (
    <div className="table-row" style={{ gridTemplateColumns: '60px 1.5fr 1fr 1fr', padding: '12px 20px', borderBottom: last ? 0 : undefined }}>
      <b>{chain}</b>
      <span className="mono" style={{ fontSize: 13, wordBreak: 'break-all' }}>
        {address ? <a href={href} target="_blank" rel="noreferrer">{address}</a> : <span className="muted">deriving…</span>}
      </span>
      <span className="mono">{balance ?? '…'} <small className="muted">{net}</small></span>
      <span className="mono orange">{heir}</span>
    </div>
  )
}

const trim = (s: string) => (s.includes('.') ? s.replace(/(\.\d{0,5})\d*$/, '$1').replace(/\.?0+$/, '') || '0' : s)

// ------------------------------------------------------------------ send

type Route = 'instant' | 'trusted' | 'over_limit' | 'contract_call' | 'locked' | 'handed_over'

function SendPanel({ acc, will, from, state, duress, onResult }: {
  acc: ReturnType<typeof keyAccount>
  will: string
  from: Hex
  state: WillState
  duress: boolean
  onResult: (r: { ok: boolean; text: string; link?: string }) => void
}) {
  const [to, setTo] = useState('')
  const [amount, setAmount] = useState('')
  const [tx, setTx] = useState<EthTxArgs | null>(null)
  const [route, setRoute] = useState<Route | null>(null)
  const [pick, setPick] = useState<'schedule' | 'trusted' | 'guardian'>('schedule')
  const [busy, setBusy] = useState(false)

  async function check() {
    setBusy(true)
    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error('Enter a 0x… ETH address')
      let value = parseEther(amount || '0')
      let t = await buildTx(from, to as Hex, value)
      if (duress) {
        // Under duress only the decoy amount can leave. The screen still shows the full amount.
        const room = BigInt(state.decoy_max) - maxFee(t)
        value = value > room ? (room > 0n ? room : 0n) : value
        t = { ...t, value: String(value) }
        setTx(t)
        setRoute('instant')
        return
      }
      setTx(t)
      setRoute(await view<Route>(will, 'classify_eth', { path: WALLET_PATHS.eth, tx: t }))
    } catch (e) {
      onResult({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  async function sendNow(t: EthTxArgs) {
    const contractHash = await view<string>(will, 'eth_signing_hash', { tx: t })
    if (`0x${contractHash}` !== signingHash(t)) throw new Error('Hash mismatch between app and contract. Not sending.')
    const res = await call<unknown>(acc, will, 'sign_eth', { path: WALLET_PATHS.eth, tx: t })
    if (typeof res === 'string' && res.startsWith('queued:')) return { ok: true, text: `Sent ${amount} ETH ✓` }
    const hash = await broadcast(t, res)
    return { ok: true, text: `Sent ${amount} ETH ✓`, link: `${EXPLORER_ETH}/tx/${hash}` }
  }

  async function go() {
    if (!tx || !route) return
    setBusy(true)
    try {
      if (route === 'instant' || route === 'trusted') {
        onResult(await sendNow(tx))
      } else if (pick === 'schedule' || pick === 'guardian') {
        const id = await call<string>(acc, will, 'schedule_eth', { path: WALLET_PATHS.eth, tx }, 30n)
        onResult({
          ok: true,
          text: pick === 'schedule'
            ? `Scheduled as #${id}. It can go out in ${fmtSecs(state.hold_secs)}, and you or a guardian can cancel until then.`
            : `Queued as #${id}. Ask a guardian to open their Guarding tab and approve it.`,
        })
      }
      setTx(null)
      setRoute(null)
      setAmount('')
    } catch (e) {
      onResult({ ok: false, text: e instanceof ContractError ? explain(e.message) : e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const needsRoute = route === 'over_limit' || route === 'contract_call'
  return (
    <div className="card plain">
      <b style={{ fontSize: 18 }}>Send ETH</b>
      <div className="row">
        <F label="To" value={to} set={(v) => { setTo(v); setRoute(null) }} ph="0x…" />
        <F label="Amount (ETH)" value={amount} set={(v) => { setAmount(v); setRoute(null) }} ph="0.01" />
      </div>
      {!route && <div><button className="btn solid" disabled={busy || !to || !amount} onClick={check}>{busy ? 'Checking…' : 'Continue'}</button></div>}
      {route === 'locked' && <div className="err">Locked. Only a guardian can lift the lockdown early.</div>}
      {(route === 'instant' || route === 'trusted') && (
        <div className="row center fade-in">
          <span className="ok">{route === 'trusted' ? 'Trusted address: no limit, instant.' : 'Inside your daily limit: instant.'}</span>
          <button className="btn accent" disabled={busy} onClick={go}>{busy ? 'Signing…' : `Send ${amount} ETH`}</button>
        </div>
      )}
      {needsRoute && (
        <div className="col fade-in" style={{ gap: 10 }}>
          <div className="err">
            {route === 'over_limit' ? "This is over today's limit and the address isn't trusted." : 'This calls a contract, which could move more than it shows.'} Pick how it goes out:
          </div>
          {[
            ['schedule', `Schedule it`, `Released after ${fmtSecs(state.hold_secs)}, then it goes out (by itself if a keeper runs, or with one tap here). You or a guardian can cancel before then.`],
            ['guardian', 'Ask a guardian', 'Queues it now; a guardian approves it from their own account and it goes straight out.'],
            ['trusted', 'Send to a trusted address instead', state.trusted.length ? `Your trusted: ${state.trusted.map((t) => `${t.label} ${short(t.address)}`).join(', ')}` : 'You have none yet. Adding one takes the hold period (Safety, below).'],
          ].map(([id, title, desc]) => (
            <button key={id} className="btn" aria-pressed={pick === id}
              style={{ justifyContent: 'flex-start', textAlign: 'left', padding: '12px 16px', flexDirection: 'column', alignItems: 'flex-start', background: pick === id ? 'var(--sel)' : 'transparent', borderColor: pick === id ? 'var(--accent-ink)' : 'var(--line)' }}
              onClick={() => setPick(id as typeof pick)}>
              <span style={{ fontSize: 14 }}>{title}</span>
              <span className="sub" style={{ fontWeight: 400, fontFamily: "'Inter Tight', system-ui, sans-serif", fontSize: 13 }}>{desc}</span>
            </button>
          ))}
          <div>
            <button className="btn accent" disabled={busy || pick === 'trusted'} onClick={go}>
              {pick === 'schedule' ? 'Schedule' : pick === 'guardian' ? 'Queue for a guardian' : 'Change the address above'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ queue

function Queue({ acc, will, pending, chainNow, run }: {
  acc: ReturnType<typeof keyAccount>
  will: string
  pending: Pending[]
  chainNow: number
  run: (label: string, fn: () => Promise<{ text: string; link?: string } | void>) => void
}) {
  if (!pending.length) return null
  return (
    <div className="card plain">
      <b style={{ fontSize: 18 }}>Waiting to go out</b>
      {pending.map((p) => {
        const due = nsToMs(p.release_at) <= chainNow && p.status === 'Waiting'
        const eth = 'Eth' in p.request ? p.request.Eth.tx : null
        return (
          <div key={p.id} className="row between center hr" style={{ padding: '10px 0' }}>
            <span className="mono" style={{ fontSize: 14 }}>
              #{p.id} · {eth ? `${formatEther(BigInt(eth.value))} ETH → ${short(eth.to)}` : 'raw signature request'}
            </span>
            <span className="row center">
              {due ? (
                <button className="btn accent" onClick={() => run('Sending', async () => {
                  const sig = await call(acc, will, 'execute', { id: String(p.id) })
                  if (!eth) return { text: 'Signed' }
                  const hash = await broadcast(eth, sig)
                  return { text: 'Sent ✓', link: `${EXPLORER_ETH}/tx/${hash}` }
                })}>Send now</button>
              ) : (
                <span className="mono amber" style={{ fontSize: 13 }}>releases in <Countdown ms={nsToMs(p.release_at) - chainNow} /></span>
              )}
              <button className="btn danger" onClick={() => run('Cancelling', () => call(acc, will, 'cancel', { id: String(p.id) }, 30n).then(() => undefined))}>Cancel</button>
            </span>
          </div>
        )
      })}
    </div>
  )
}

// ------------------------------------------------------------------ safety

function Safety({ acc, will, state, chainNow, spentWei, limitWei, run, duress }: {
  acc: ReturnType<typeof keyAccount>
  will: string
  state: WillState
  chainNow: number
  spentWei?: string
  limitWei?: string
  run: (label: string, fn: () => Promise<{ text: string; link?: string } | void>) => void
  duress: boolean
}) {
  const [addr, setAddr] = useState('')
  const [label, setLabel] = useState('')
  const [guardian, setGuardian] = useState('')
  const [limit, setLimit] = useState('')
  const pct = limitWei && BigInt(limitWei) > 0n ? Number((BigInt(spentWei ?? '0') * 100n) / BigInt(limitWei)) : 0
  const propose = (label: string, change: Record<string, unknown>) =>
    run(label, async () => {
      const id = await call<string>(acc, will, 'propose', { change }, 30n)
      return { text: duress ? 'Saved ✓' : `${label}: proposed as #${id}. Loosening changes wait ${fmtSecs(state.hold_secs)}; tightening applies now.` }
    })

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row between" style={{ alignItems: 'baseline', paddingTop: 10 }}>
        <h2 className="display" style={{ margin: 0, fontSize: 24 }}>Safety</h2>
        <span className="muted" style={{ fontSize: 13 }}>Tightening applies now. Loosening waits {fmtSecs(state.hold_secs)}.</span>
      </div>
      <div className="row" style={{ gap: 20 }}>
        <div className="card plain grow">
          <b>Daily limit</b>
          <div className="row between mono" style={{ fontSize: 13 }}>
            <span className="muted">used today</span>
            <span>{formatEther(BigInt(spentWei ?? '0'))} / {formatEther(BigInt(limitWei ?? '0'))} ETH</span>
          </div>
          <div style={{ height: 8, background: 'var(--track)' }}><div style={{ height: 8, width: `${Math.min(100, pct)}%`, background: 'var(--accent-ink)', transition: 'width .6s' }} /></div>
          <div className="row center">
            <F label="New limit (ETH)" value={limit} set={setLimit} ph="0.05" />
            <button className="btn" style={{ alignSelf: 'flex-end' }} disabled={!limit} onClick={() => propose('Daily limit', { SetDailyLimit: { path: WALLET_PATHS.eth, limit: parseEther(limit).toString() } })}>Set</button>
          </div>
        </div>
        <div className="card plain grow">
          <b>Trusted addresses</b>
          <span className="hint">Any amount, instantly.</span>
          {state.trusted.map((t) => (
            <div key={t.address} className="row between center hr" style={{ padding: '6px 0', fontSize: 14 }}>
              <span>{t.label}</span>
              <span className="row center"><span className="mono">{short(t.address)}</span>
                <button className="btn" style={{ minHeight: 34 }} onClick={() => propose('Remove trusted', { RemoveTrusted: { address: t.address } })}>Remove</button></span>
            </div>
          ))}
          <F label="Address" value={addr} set={setAddr} ph="0x…" />
          <F label="Label" value={label} set={setLabel} ph="my ledger" />
          <div><button className="btn" disabled={!addr} onClick={() => propose('Add trusted', { AddTrusted: { trusted: { chain: 'Eth', address: addr, label: label || 'trusted' } } })}>Add (waits {fmtSecs(state.hold_secs)})</button></div>
        </div>
        <div className="card plain grow">
          <b>Guardians</b>
          <span className="hint">Can approve or cancel big sends and lift a lockdown. Can never take funds.</span>
          {state.guardians.map((g) => (
            <div key={g} className="row between center hr" style={{ padding: '6px 0', fontSize: 14 }}>
              <span className="mono">{g}</span>
              <button className="btn" style={{ minHeight: 34 }} onClick={() => propose('Remove guardian', { RemoveGuardian: { account: g } })}>Remove</button>
            </div>
          ))}
          <F label="Add guardian" value={guardian} set={setGuardian} ph="rafi.testnet" />
          <div><button className="btn" disabled={!guardian} onClick={() => propose('Add guardian', { AddGuardian: { account: guardian } })}>Add (waits {fmtSecs(state.hold_secs)})</button></div>
          <div className="row between" style={{ fontSize: 14 }}><span>Duress password</span><b className={state.has_duress_key ? 'ink' : 'muted'}>{state.has_duress_key ? 'set' : 'not set'}</b></div>
        </div>
      </div>
      {state.changes.length > 0 && (
        <div className="card plain">
          <b>Waiting changes</b>
          {state.changes.map((c) => {
            const due = nsToMs(c.apply_at) <= chainNow
            return (
              <div key={c.id} className="row between center hr" style={{ padding: '8px 0' }}>
                <span className="mono" style={{ fontSize: 13 }}>#{c.id} · {describeChange(c.change)}</span>
                <span className="row center">
                  {due ? (
                    <button className="btn accent" onClick={() => run('Applying', () => call(acc, will, 'apply_change', { id: String(c.id) }, 30n).then(() => undefined))}>Apply</button>
                  ) : (
                    <span className="mono amber" style={{ fontSize: 13 }}>applies in <Countdown ms={nsToMs(c.apply_at) - chainNow} /></span>
                  )}
                  <button className="btn danger" onClick={() => run('Cancelling', () => call(acc, will, 'cancel_change', { id: String(c.id) }, 30n).then(() => undefined))}>Cancel</button>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ helpers

function CopyLink({ label, url, onCopy }: { label: string; url: string; onCopy?: () => void }) {
  const [done, setDone] = useState(false)
  return (
    <button className="btn" style={{ minHeight: 38, fontSize: 12 }}
      onClick={() => navigator.clipboard.writeText(url).then(() => { onCopy?.(); setDone(true); setTimeout(() => setDone(false), 1500) })}>
      {done ? 'Copied ✓' : label}
    </button>
  )
}

export function fmtSecs(s: string | number) {
  const n = Number(s)
  if (n % 86400 === 0) return `${n / 86400} day${n === 86400 ? '' : 's'}`
  if (n % 3600 === 0) return `${n / 3600}h`
  if (n >= 120) return `${Math.round(n / 60)} min`
  return `${n}s`
}

export function ago(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

export function describeChange(c: Record<string, unknown>): string {
  const [k, v] = Object.entries(c)[0] as [string, Record<string, unknown>]
  switch (k) {
    case 'AddTrusted': return `trust ${short(String((v.trusted as Record<string, string>).address))}`
    case 'RemoveTrusted': return `untrust ${short(String(v.address))}`
    case 'AddGuardian': return `add guardian ${v.account}`
    case 'RemoveGuardian': return `remove guardian ${v.account}`
    case 'SetDailyLimit': return `daily limit → ${formatEther(BigInt(String(v.limit)))} ETH`
    case 'AddOwnerKey': return `new app key (device recovery)`
    case 'SetHeir': return `heir of ${v.path} → ${v.heir}`
    default: return k
  }
}

function explain(msg: string) {
  if (msg.includes('needs_route:over_limit')) return "Over today's limit. Pick a route."
  if (msg.includes('needs_route:contract_call')) return 'Contract calls need a route.'
  if (msg.includes('locked')) return 'Locked. Only a guardian can lift it early.'
  if (msg.includes('unregistered key')) return "This device's key isn't registered in your will (usually because setup was submitted twice). Request a new app key: it activates after the hold, and your guardians are told."
  return msg
}
