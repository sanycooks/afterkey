import { useEffect, useMemo, useState } from 'react'
import { formatEther, formatUnits, type Hex } from 'viem'
import { Countdown, Pulse, short } from '../components/Chrome'
import { EXPLORER_BTC, EXPLORER_ETH, EXPLORER_SOL, FACTORY, WALLET_PATHS, telegramLink } from '../lib/config'
import { KNOWN_TOKENS, balanceOf, broadcast, buildTx, deriveEthAddress, maxFee, signingHash, tokenBalances, tokenInfo, transferData, waitFor, type EthTxArgs, type TokenBalance } from '../lib/eth'
import { btcWallet, solWallet, type ChainWallet } from '../lib/multichain'
import { Dapps } from './Dapps'
import { addFunctionKey, call, keyAccount, newKey, nsToMs, willOf } from '../lib/near'
import { useNow } from '../lib/prefs'
import { chainNowMs, useWill } from '../lib/useWill'
import { loadRoleKey, saveRoleKey } from '../lib/vault'
import { sendWithWallet } from '../lib/wallet'
import { F } from './Setup'
import { describeChange } from './Owner'

type Role = 'guard' | 'heir'

/** What each role can and can't do, shown before a will is opened. */
const ROLE_INTRO: Record<Role, { lead: string; points: [string, string][] }> = {
  guard: {
    lead: "Someone trusts you to stop anyone from forcing them to empty their wallet. You can slow money down or let it through. You can never take it.",
    points: [
      ['Approve', 'A big send they really mean goes out now, instead of waiting 48 hours.'],
      ['Cancel', "A send or a settings change that doesn't look like them is stopped."],
      ['Lift a lockdown', 'If they used their duress password, you unfreeze the wallet once they are safe.'],
    ],
  },
  heir: {
    lead: "Someone named you to inherit their wallets. Nothing is yours while they're active, and nobody has to report anything if they're gone.",
    points: [
      ['While they are active', 'You see the countdown, nothing else. You cannot move anything.'],
      ['If they go silent', 'After 30 days plus 7 days of grace, the will hands over by itself.'],
      ['Then', 'You sign from the same addresses, with everything inside, including airdrops that land later.'],
    ],
  },
}

function lastKey(role: Role) {
  return `afterkey:last:${role}`
}

/** Pick a will by its owner's account. Invite links (#/app?guard=alice.testnet) open it straight away. */
function WillPicker({ role, onPick }: { role: Role; onPick: (will: string) => void }) {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '')
  const fromLink = params.get(role) ?? params.get('will')
  const [v, setV] = useState(fromLink ?? localStorage.getItem(lastKey(role)) ?? '')
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  async function go(input = v) {
    setErr('')
    const s = input.trim()
    if (!s) return
    setBusy(true)
    try {
      const will = s.endsWith(`.${FACTORY}`) ? s : await willOf(s)
      localStorage.setItem(lastKey(role), s)
      onPick(will)
    } catch {
      setErr("Couldn't find that will")
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (fromLink) go(fromLink)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const intro = ROLE_INTRO[role]
  return (
    <div className="col" style={{ gap: 26 }}>
      <p className="sub" style={{ margin: 0, fontSize: 17, lineHeight: 1.6, maxWidth: 680 }}>{intro.lead}</p>
      <div className="row" style={{ gap: 16 }}>
        {intro.points.map(([t, d], i) => (
          <div key={t} className="card plain grow" style={{ gap: 8 }}>
            <span className="display ink" style={{ fontSize: 20 }}>0{i + 1}</span>
            <b>{t}</b>
            <span className="sub" style={{ fontSize: 14, lineHeight: 1.55 }}>{d}</span>
          </div>
        ))}
      </div>
      <form className="row" style={{ alignItems: 'flex-end', maxWidth: 680 }} onSubmit={(e) => { e.preventDefault(); go() }}>
        <F label="The owner's NEAR account" value={v} set={setV} ph="alice.testnet" />
        <button className="btn solid" disabled={!v || busy}>{busy ? 'Opening…' : 'Open their will'}</button>
      </form>
      <span className="hint">Tip: the owner can send you a link from their dashboard that opens this page with their will already filled in.</span>
      {err && <div className="err">{err}</div>}
    </div>
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
  const [done, setDone] = useState([false, false, false])

  if (!will) return <Page title="Guarding a will"><WillPicker role="guard" onPick={setWill} /></Page>
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
        <div className="col" style={{ gap: 0 }}>
          <div className="row between center" style={{ background: 'var(--red)', color: 'var(--on-red)', padding: '16px 20px' }}>
            <b style={{ fontSize: 17 }}>{state.owner} used the duress password.</b>
            <span className="mono" style={{ fontWeight: 700 }}>Locked · <Countdown ms={nsToMs(state.locked_until) - chainNow} /> left</span>
          </div>
          <div className="card plain" style={{ borderTop: 0 }}>
            <b>What to do now</b>
            {PLAYBOOK.map(([title, text], i) => (
              <label key={title} className="row" style={{ gap: 12, alignItems: 'flex-start', fontSize: 15, lineHeight: 1.5, flexWrap: 'nowrap' }}>
                <input type="checkbox" checked={done[i]} onChange={() => setDone((d) => d.map((x, j) => (j === i ? !x : x)))}
                  style={{ width: 20, height: 20, marginTop: 2, accentColor: 'var(--accent-ink)', flex: 'none' }} />
                <span><b>{title}</b> {text}</span>
              </label>
            ))}
            <div className="row center">
              <button className="btn" disabled={!acc || !done.every(Boolean)} onClick={() => run('Lifting lockdown', () => call(acc!, will, 'lift_lockdown', {}, 30n).then(() => undefined))}>Lift lockdown</button>
              <span className="muted" style={{ fontSize: 13 }}>{done.every(Boolean) ? 'Only if they are safe.' : 'Unlocks after you tick all three.'}</span>
            </div>
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

const PLAYBOOK: [string, string][] = [
  ['Call them.', "Don't text. Hear their voice."],
  ['Ask your code word.', "The one you agreed in person. A wrong answer or no answer means they're not safe."],
  ["If you can't reach them,", 'contact family or the police. Approve nothing.'],
]

// ------------------------------------------------------------------ heir

export function Heir({ account }: { account: string }) {
  const [will, setWill] = useState<string | null>(null)
  const { state, refresh, fetchedAt } = useWill(will)
  const now = useNow()
  const { key, link } = useRoleKey(account, will)
  const acc = useMemo(() => (key ? keyAccount(account, key) : null), [account, key])
  const [addr, setAddr] = useState<Hex | null>(null)
  const [bal, setBal] = useState<bigint | null>(null)
  const [tokens, setTokens] = useState<TokenBalance[]>([])
  const [extra, setExtra] = useState<{ symbol: string; address: Hex; decimals: number }[]>([])
  const [newToken, setNewToken] = useState('')
  const [sol, setSol] = useState<ChainWallet | null>(null)
  const [btc, setBtc] = useState<ChainWallet | null>(null)
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string; link?: string } | null>(null)

  const ethWallet = state?.wallets.find((w) => w.path === WALLET_PATHS.eth && w.heir === account)
  const solMine = state?.wallets.some((w) => w.path === WALLET_PATHS.sol && w.heir === account)
  const btcMine = state?.wallets.some((w) => w.path === WALLET_PATHS.btc && w.heir === account)
  useEffect(() => {
    if (!will) return
    if (ethWallet) deriveEthAddress(will, WALLET_PATHS.eth).then(setAddr)
    if (solMine) solWallet(will, WALLET_PATHS.sol).then(setSol).catch(() => {})
    if (btcMine) btcWallet(will, WALLET_PATHS.btc).then(setBtc).catch(() => {})
  }, [will, ethWallet, solMine, btcMine])
  useEffect(() => {
    if (!addr) return
    const load = () => {
      balanceOf(addr).then(setBal).catch(() => {})
      tokenBalances(addr, [...KNOWN_TOKENS, ...extra]).then(setTokens).catch(() => {})
    }
    load()
    const t = setInterval(load, 10_000)
    return () => clearInterval(t)
  }, [addr, extra])

  if (!will) return <Page title="Inheriting"><WillPicker role="heir" onPick={setWill} /></Page>
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
        <a className="btn" style={{ alignSelf: 'flex-start' }} href={telegramLink('heir', state.owner)} target="_blank" rel="noreferrer">Tell me on Telegram when it's mine</a>
      </Page>
    )
  }

  /** Signs one transaction from the inherited ETH wallet and broadcasts it. */
  async function sign(t: EthTxArgs) {
    const sig = await call(acc!, will!, 'heir_sign', { path: WALLET_PATHS.eth, payload: signingHash(t).slice(2), domain_id: 0 })
    return broadcast(t, sig)
  }

  async function moveToken(tk: TokenBalance) {
    if (!acc || !addr) return
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return setMsg({ ok: false, text: 'Enter the 0x… address to send to first' })
    setBusy(true)
    setMsg({ ok: true, text: `Moving ${tk.symbol}…` })
    try {
      const hash = await sign(await buildTx(addr, tk.address, 0n, transferData(to as Hex, tk.balance)))
      setMsg({ ok: true, text: `${tk.symbol} sent ✓`, link: `${EXPLORER_ETH}/tx/${hash}` })
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  async function moveEverything() {
    if (!acc || !addr) return
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return setMsg({ ok: false, text: 'Enter the 0x… address to send to' })
    setBusy(true)
    try {
      // Tokens first (they need ETH for gas), then whatever ETH is left.
      for (const tk of tokens) {
        setMsg({ ok: true, text: `Moving ${tk.symbol}…` })
        await waitFor(await sign(await buildTx(addr, tk.address, 0n, transferData(to as Hex, tk.balance))))
      }
      setMsg({ ok: true, text: 'Moving ETH…' })
      let t = await buildTx(addr, to as Hex, 0n)
      const b = await balanceOf(addr)
      t = { ...t, value: String(b - maxFee(t) > 0n ? b - maxFee(t) : 0n) }
      const hash = await sign(t)
      setMsg({ ok: true, text: 'Everything moved ✓', link: `${EXPLORER_ETH}/tx/${hash}` })
      refresh()
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  async function addToken() {
    try {
      if (!/^0x[0-9a-fA-F]{40}$/.test(newToken)) throw new Error('Enter a token contract address')
      const info = await tokenInfo(newToken as Hex)
      setExtra((x) => [...x, info])
      setNewToken('')
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
  }

  const grid = { gridTemplateColumns: 'minmax(0, 1fr) 160px 110px' }
  return (
    <Page title={`${state.owner} left you ${mine.length === 1 ? 'a wallet' : `${mine.length} wallets`}.`}>
      <span className="mono orange" style={{ fontSize: 12 }}>HANDED OVER · {new Date(handoverAt).toLocaleDateString()}</span>
      <p className="sub" style={{ margin: 0, fontSize: 16 }}>Same addresses, everything inside. Only you can sign from them now.</p>
      {msg && <div className={msg.ok ? 'ok' : 'err'}>{msg.text} {msg.link && <a href={msg.link} target="_blank" rel="noreferrer">view →</a>}</div>}
      {!acc && (
        <div className="card plain">
          <b>Link this device as heir</b>
          <span className="hint">One wallet approval, then you sign from the inherited wallets here.</span>
          <div><button className="btn accent" onClick={() => link().catch((e) => setMsg({ ok: false, text: String(e) }))}>Link</button></div>
        </div>
      )}

      <div className="row" style={{ gap: 20, alignItems: 'flex-start' }}>
        {ethWallet && (
          <section className="card grow" style={{ flex: '1 1 520px' }}>
            <div className="row between" style={{ alignItems: 'baseline' }}>
              <b className="display" style={{ fontSize: 22 }}>ETH</b>
              <span className="mono" style={{ fontSize: 13 }}>{addr ? <a href={`${EXPLORER_ETH}/address/${addr}`} target="_blank" rel="noreferrer">{short(addr, 8)}</a> : '…'}</span>
            </div>
            <div className="col" style={{ gap: 0 }}>
              <div className="table-row" style={grid}><span>ETH</span><span className="mono">{bal === null ? '…' : trimNum(formatEther(bal))}</span><span className="muted" style={{ fontSize: 12 }}>moved last</span></div>
              {tokens.map((tk) => (
                <div key={tk.address} className="table-row" style={grid}>
                  <span>{tk.symbol}</span>
                  <span className="mono">{trimNum(formatUnits(tk.balance, tk.decimals))}</span>
                  <button className="btn" style={{ minHeight: 36, fontSize: 12 }} disabled={!acc || busy} onClick={() => moveToken(tk)}>Move</button>
                </div>
              ))}
              <div className="table-row" style={grid}><span className="muted">Positions, NFTs, airdrops</span><span className="muted mono" style={{ fontSize: 12 }}>in dApps</span><span className="muted" style={{ fontSize: 12 }}>use a dApp →</span></div>
            </div>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <F label="Another token (contract address)" value={newToken} set={setNewToken} ph="0x…" />
              <button className="btn" onClick={addToken} disabled={!newToken}>Add</button>
            </div>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <F label="Send everything to" value={to} set={setTo} ph="0x… your own wallet" />
              <button className="btn accent" disabled={!acc || !to || busy} onClick={moveEverything}>{busy ? 'Working…' : 'Move everything'}</button>
            </div>
          </section>
        )}
        <div className="col grow" style={{ flex: '1 1 380px', gap: 20 }}>
          {ethWallet && addr && acc && (
            <Dapps acc={acc} will={will} from={addr} state={state} duress={false} heir onResult={(r) => { setMsg(r); refresh() }} />
          )}
          {solMine && <ChainCard chain="SOL" w={sol} unit="SOL" href={sol ? EXPLORER_SOL(sol.address) : undefined} />}
          {btcMine && <ChainCard chain="BTC" w={btc} unit="BTC" href={btc ? EXPLORER_BTC(btc.address) : undefined} />}
        </div>
      </div>
    </Page>
  )
}

function ChainCard({ chain, w, unit, href }: { chain: string; w: ChainWallet | null; unit: string; href?: string }) {
  return (
    <div className="card plain row between center" style={{ flexDirection: 'row' }}>
      <div className="col" style={{ gap: 4 }}>
        <b className="display" style={{ fontSize: 18 }}>{chain}</b>
        <span className="mono muted" style={{ fontSize: 13 }}>
          {w ? <a href={href} target="_blank" rel="noreferrer">{short(w.address, 6)}</a> : 'deriving…'}{w?.balance != null ? ` · ${w.balance} ${unit}` : ''}
        </span>
      </div>
      <span className="muted" style={{ fontSize: 13 }}>yours · moving it comes next</span>
    </div>
  )
}

const trimNum = (s: string) => (s.includes('.') ? s.replace(/(\.\d{0,6})\d*$/, '$1').replace(/\.?0+$/, '') || '0' : s)

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="col" style={{ gap: 18, padding: '40px 0 80px', maxWidth: 1000 }}>
      <h1 className="display" style={{ margin: 0, fontSize: 'clamp(28px, 4vw, 40px)' }}>{title}</h1>
      {children}
    </div>
  )
}
