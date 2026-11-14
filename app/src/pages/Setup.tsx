import { useEffect, useState } from 'react'
import { formatUnits, parseEther } from 'viem'
import { FACTORY, WALLET_PATHS } from '../lib/config'
import { addFunctionKey, createWillAction, getState, newKey, publicKeyOf, willDeposit } from '../lib/near'
import { createVault, forgetVault, hasVault, unlock } from '../lib/vault'
import { sendWithWallet } from '../lib/wallet'

const DEMO = { alive: 120, grace: 60, hold: 30, lockdown: 90 }
const REAL = { hold: 48 * 3600, lockdown: 7 * 86400 }

export default function Setup({ account, will, onDone }: { account: string; will: string; onDone: () => void }) {
  const [heir, setHeir] = useState('')
  const [btcHeir, setBtcHeir] = useState('')
  const [guardians, setGuardians] = useState('')
  const [trusted, setTrusted] = useState('')
  const [limit, setLimit] = useState('0.05')
  const [decoy, setDecoy] = useState('0.002')
  const [demo, setDemo] = useState(false)
  const [aliveDays, setAliveDays] = useState<30 | 90 | 180>(90)
  const [graceDays, setGraceDays] = useState<7 | 14 | 30>(14)
  const [step, setStep] = useState(0)
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [duressPw, setDuressPw] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [deposit, setDeposit] = useState<bigint | null>(null)
  useEffect(() => {
    willDeposit().then(setDeposit).catch(() => setErr("Couldn't read the factory. Is VITE_FACTORY set to the deployed factory?"))
  }, [])

  const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean)

  async function submit() {
    setErr('')
    const heirs = [heir.trim(), (btcHeir || heir).trim()]
    if (!heirs[0].includes('.')) return setErr('Enter your heir as a NEAR account, like amina.testnet')
    if (heirs.includes(account)) return setErr("You can't be your own heir")
    const gs = list(guardians)
    if (gs.includes(account)) return setErr("You can't be your own guardian")
    if (pw.length < 8) return setErr('Use an app password of at least 8 characters')
    if (pw !== pw2) return setErr("The two app passwords don't match")
    if (duressPw && duressPw === pw) return setErr('The duress password must be different from the app password')
    let limitWei: bigint, decoyWei: bigint
    try {
      limitWei = parseEther(limit)
      decoyWei = parseEther(decoy)
    } catch {
      return setErr('Limit and decoy must be ETH amounts, like 0.05')
    }
    const trustedList = list(trusted).map((address, i) => {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Not an ETH address: ${address}`)
      return { chain: 'Eth', address, label: `trusted ${i + 1}` }
    })

    const t = demo ? DEMO : { ...REAL, alive: aliveDays * 86400, grace: graceDays * 86400 }
    if (deposit === null) return setErr("Couldn't read the storage deposit from the factory")
    if (await getState(will)) return onDone() // already created, e.g. the wallet finished after a reload

    // A retry must reuse the first attempt's keys. New keys would overwrite the saved ones,
    // and if the first attempt did create the will, this device would hold a key the will doesn't know.
    let app: { secretKey: string; publicKey: string }
    let duress: { secretKey: string; publicKey: string } | null = null
    const retry = hasVault(account)
    if (retry) {
      const u = await unlock(account, pw)
      if (!u || u.mode !== 'normal') return setErr('Setup was already started on this device. Enter the same app password you used then, or press "Start over".')
      app = { secretKey: u.secretKey, publicKey: publicKeyOf(u.secretKey) }
      if (duressPw) {
        const d = await unlock(account, duressPw)
        if (!d || d.mode !== 'duress') return setErr('Enter the same duress password you used the first time, or leave it empty.')
        duress = { secretKey: d.secretKey, publicKey: publicKeyOf(d.secretKey) }
      }
    } else {
      app = newKey()
      duress = duressPw ? newKey() : null
    }
    const args = {
      owner: account,
      owner_keys: [app.publicKey],
      duress_key: duress?.publicKey ?? null,
      wallets: [
        { path: WALLET_PATHS.eth, chain: 'Eth', heir: heirs[0], daily_limit: limitWei.toString() },
        { path: WALLET_PATHS.sol, chain: 'Sol', heir: heirs[0], daily_limit: '0' },
        { path: WALLET_PATHS.btc, chain: 'Btc', heir: heirs[1], daily_limit: '0' },
      ],
      guardians: gs,
      trusted: trustedList,
      alive_secs: String(t.alive),
      grace_secs: String(t.grace),
      hold_secs: String(t.hold),
      lockdown_secs: String(t.lockdown),
      decoy_max: decoyWei.toString(),
      mpc_contract: 'v1.signer-prod.testnet',
      demo,
    }

    setBusy(true)
    try {
      // Save the encrypted keys first: browser wallets may redirect away from this page.
      if (!retry) await createVault(
        account,
        will,
          { secretKey: app.secretKey, password: pw },
          duress ? { secretKey: duress.secretKey, password: duressPw } : undefined,
        )
      const keyActions = [addFunctionKey(app.publicKey, will)]
      if (duress) keyActions.push(addFunctionKey(duress.publicKey, will))
      await sendWithWallet([
        { receiverId: account, actions: keyActions },
        { receiverId: FACTORY, actions: [createWillAction(args, deposit)] },
      ])
      onDone()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const steps = ['Heirs', 'Timer', 'Protection', 'Passwords', 'Review']
  const timing = demo ? 'Demo: 2 min + 1 min grace' : `${aliveDays} days + ${graceDays} days grace`

  function check(i: number): string {
    if (i === 0) {
      const h = heir.trim()
      if (!h.includes('.')) return 'Enter your heir as a NEAR account, like amina.testnet'
      if (h === account || btcHeir.trim() === account) return "You can't be your own heir"
    }
    if (i === 2) {
      if (list(guardians).includes(account)) return "You can't be your own guardian"
      try { parseEther(limit); parseEther(decoy) } catch { return 'Limit and decoy must be ETH amounts, like 0.05' }
      const bad = list(trusted).find((a) => !/^0x[0-9a-fA-F]{40}$/.test(a))
      if (bad) return `Not an ETH address: ${bad}`
    }
    if (i === 3) {
      if (pw.length < 8) return 'Use an app password of at least 8 characters'
      if (pw !== pw2) return "The two app passwords don't match"
      if (duressPw && duressPw === pw) return 'The duress password must be different from the app password'
    }
    return ''
  }
  function next() {
    const e = check(step)
    setErr(e)
    if (!e) setStep(step + 1)
  }

  const choice = (on: boolean) => ({
    textAlign: 'left' as const, padding: 18, cursor: 'pointer', display: 'flex', flexDirection: 'column' as const, gap: 6,
    border: `1px solid ${on ? 'var(--accent-ink)' : 'var(--line)'}`, background: on ? 'var(--sel)' : 'transparent', color: 'var(--text)',
  })

  return (
    <div className="col" style={{ gap: 28, padding: '32px 0 80px', maxWidth: 1100 }}>
      <div className="row mono" style={{ gap: 8, fontSize: 12 }} aria-label={`Step ${step + 1} of 5`}>
        {steps.map((s, i) => (
          <div key={s} className="col grow" style={{ flex: '1 1 0', gap: 8 }}>
            <div style={{ height: 4, background: i < step ? 'var(--accent-ink)' : i === step ? 'var(--text)' : 'var(--line)' }} />
            <span style={{ color: i < step ? 'var(--accent-ink)' : i === step ? 'var(--text)' : 'var(--muted)', fontWeight: i === step ? 700 : 400 }}>
              {i + 1} {s}{i < step ? ' ✓' : ''}
            </span>
          </div>
        ))}
      </div>

      <div className="row" style={{ gap: 28, alignItems: 'flex-start' }}>
        <div className="col grow fade-in" key={step} style={{ flex: '2 1 520px', gap: 20 }}>
          {step === 0 && (<>
            <h1 className="display" style={{ margin: 0, fontSize: 32 }}>Who gets your wallets?</h1>
            <p className="sub" style={{ margin: 0, fontSize: 16, lineHeight: 1.6 }}>Heirs only need a NEAR account. They can't see or touch anything until the handover.</p>
            <div className="row">
              <F label="Heir of your ETH and SOL wallets" value={heir} set={setHeir} ph="amina.testnet" />
              <F label="Heir of your BTC wallet (optional)" value={btcHeir} set={setBtcHeir} ph="same as above" />
            </div>
          </>)}

          {step === 1 && (<>
            <h1 className="display" style={{ margin: 0, fontSize: 32 }}>How long before it hands over?</h1>
            <p className="sub" style={{ margin: 0, fontSize: 16, lineHeight: 1.6 }}>If nothing comes from your wallets for this long, grace starts. Pick longer if you travel or might be in hospital.</p>
            {!demo && (<>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
                {([[30, 'Active every month'], [90, 'Recommended'], [180, 'Rarely active']] as const).map(([d, note]) => (
                  <button key={d} aria-pressed={aliveDays === d} onClick={() => setAliveDays(d)} style={choice(aliveDays === d)}>
                    <b className="mono" style={{ fontSize: 22, color: aliveDays === d ? 'var(--accent-ink)' : undefined }}>{d} days</b>
                    <span className="sub" style={{ fontSize: 13 }}>{note}</span>
                  </button>
                ))}
              </div>
              <div className="col" style={{ gap: 10 }}>
                <span className="muted" style={{ fontSize: 14 }}>Grace period (Telegram warns you)</span>
                <div className="seg" role="group" aria-label="Grace period">
                  {([7, 14, 30] as const).map((d) => (
                    <button key={d} aria-pressed={graceDays === d} onClick={() => setGraceDays(d)}>{d} days</button>
                  ))}
                </div>
              </div>
            </>)}
            {demo && <div className="ok">Demo timers: grace after 2 minutes of silence, handover 1 minute later, big sends hold 30 seconds.</div>}
            <button className="mono" onClick={() => setDemo(!demo)} style={{ alignSelf: 'flex-start', background: 'none', border: 0, padding: '10px 0', color: 'var(--accent-ink)', cursor: 'pointer', textDecoration: 'underline', fontSize: 13 }}>
              {demo ? 'Use real timers instead' : 'Use demo timers (minutes) instead'}
            </button>
          </>)}

          {step === 2 && (<>
            <h1 className="display" style={{ margin: 0, fontSize: 32 }}>If someone forces you</h1>
            <p className="sub" style={{ margin: 0, fontSize: 16, lineHeight: 1.6 }}>
              Sends over the limit, and any contract call, wait {demo ? '30 seconds' : '48 hours'} unless they go to a trusted address or a guardian approves.
            </p>
            <div className="row">
              <F label="Daily limit (ETH)" value={limit} set={setLimit} ph="0.05" />
              <F label="Decoy sent under duress (ETH)" value={decoy} set={setDecoy} ph="0.002" />
            </div>
            <F label="Guardians: NEAR accounts, comma separated. They can approve or cancel, never take." value={guardians} set={setGuardians} ph="rafi.testnet, noor.testnet" />
            <F label="Trusted ETH addresses: your own Ledger or exchange (optional)" value={trusted} set={setTrusted} ph="0x…" />
          </>)}

          {step === 3 && (<>
            <h1 className="display" style={{ margin: 0, fontSize: 32 }}>Passwords on this device</h1>
            <p className="sub" style={{ margin: 0, fontSize: 16, lineHeight: 1.6 }}>
              The duress password opens the app exactly like the real one, but only the decoy leaves, everything locks, and your guardians are alerted.
            </p>
            <div className="row">
              <F label="App password" value={pw} set={setPw} type="password" />
              <F label="Repeat app password" value={pw2} set={setPw2} type="password" />
            </div>
            <F label="Duress password (optional, must be different)" value={duressPw} set={setDuressPw} type="password" />
          </>)}

          {step === 4 && (<>
            <h1 className="display" style={{ margin: 0, fontSize: 32 }}>Ready to create your will</h1>
            <p className="sub" style={{ margin: 0, fontSize: 16, lineHeight: 1.6 }}>
              It lives at <span className="mono">{will}</span>, created with no keys, so nobody, including us, can change it after this. Your wallet asks you to approve two things.
            </p>
          </>)}

          {err && <div className="err">{err}</div>}
          <div className="row" style={{ gap: 12 }}>
            {step > 0 && <button className="btn big" disabled={busy} onClick={() => { setErr(''); setStep(step - 1) }}>Back</button>}
            {step < 4 ? (
              <button className="btn accent big" onClick={next}>Next: {steps[step + 1].toLowerCase()}</button>
            ) : (
              <button className="btn accent big" disabled={busy} onClick={submit}>
                {busy ? 'Waiting for your wallet…' : `Create will · ${deposit === null ? '…' : Number(formatUnits(deposit, 24)).toFixed(2)} NEAR`}
              </button>
            )}
            {hasVault(account) && step === 4 && (
              <button className="btn" onClick={() => { forgetVault(account); setErr('Started over. Choose new passwords.'); setStep(3) }}>Start over</button>
            )}
          </div>
        </div>

        <aside className="card grow" style={{ flex: '1 1 300px', gap: 10 }}>
          <b style={{ fontSize: 15 }}>Your will so far</b>
          <Line k="ETH + SOL" v={heir || '—'} orange />
          <Line k="BTC" v={btcHeir || heir || '—'} orange />
          <Line k="Hands over after" v={timing} />
          <Line k="Daily limit" v={`${limit || '—'} ETH`} />
          <Line k="Guardians" v={list(guardians).join(', ') || 'none'} />
          <Line k="Duress password" v={duressPw ? 'set' : 'not set'} />
          <Line k="Storage" v={deposit === null ? '…' : `${Number(formatUnits(deposit, 24)).toFixed(2)} NEAR`} last />
        </aside>
      </div>
    </div>
  )
}

function Line({ k, v, orange, last }: { k: string; v: string; orange?: boolean; last?: boolean }) {
  return (
    <div className="row between" style={{ padding: '8px 0', borderBottom: last ? 0 : '1px solid var(--line)', fontSize: 14, gap: 10 }}>
      <span className="muted">{k}</span>
      <span className={`mono${orange ? ' orange' : ''}`} style={{ textAlign: 'right', wordBreak: 'break-all' }}>{v}</span>
    </div>
  )
}

export function F({ label, value, set, ph, type = 'text' }: { label: string; value: string; set: (s: string) => void; ph?: string; type?: string }) {
  const id = label.replace(/\W+/g, '-').toLowerCase()
  return (
    <div className="field grow">
      <label htmlFor={id}>{label}</label>
      <input id={id} type={type} value={value} placeholder={ph} onChange={(e) => set(e.target.value)} autoComplete="off" />
    </div>
  )
}
