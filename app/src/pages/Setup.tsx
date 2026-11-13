import { useEffect, useState } from 'react'
import { formatUnits, parseEther } from 'viem'
import { FACTORY, WALLET_PATHS } from '../lib/config'
import { addFunctionKey, createWillAction, getState, newKey, publicKeyOf, willDeposit } from '../lib/near'
import { createVault, forgetVault, hasVault, unlock } from '../lib/vault'
import { sendWithWallet } from '../lib/wallet'

const DEMO = { alive: 120, grace: 60, hold: 30, lockdown: 90 }
const REAL = { alive: 30 * 86400, grace: 7 * 86400, hold: 48 * 3600, lockdown: 7 * 86400 }

export default function Setup({ account, will, onDone }: { account: string; will: string; onDone: () => void }) {
  const [heir, setHeir] = useState('')
  const [btcHeir, setBtcHeir] = useState('')
  const [guardians, setGuardians] = useState('')
  const [trusted, setTrusted] = useState('')
  const [limit, setLimit] = useState('0.05')
  const [decoy, setDecoy] = useState('0.002')
  const [demo, setDemo] = useState(true)
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

    const t = demo ? DEMO : REAL
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

  return (
    <div className="col" style={{ gap: 28, padding: '40px 0 80px', maxWidth: 880 }}>
      <div className="col" style={{ gap: 8 }}>
        <h1 className="display" style={{ margin: 0, fontSize: 40 }}>Create your will</h1>
        <p className="sub" style={{ margin: 0, fontSize: 16 }}>
          Your will lives at <span className="mono">{will}</span>. It's created with no keys, so nobody, including
          us, can change it after this.
        </p>
      </div>

      <Section n="1" title="Who inherits">
        <div className="row">
          <F label="Heir of your ETH and SOL wallets" value={heir} set={setHeir} ph="amina.testnet" />
          <F label="Heir of your BTC wallet (optional)" value={btcHeir} set={setBtcHeir} ph="same as above" />
        </div>
        <p className="hint">Heirs only need a NEAR account. They can't see or touch anything until the handover.</p>
      </Section>

      <Section n="2" title="Timing">
        <div className="seg" role="group" aria-label="Timer mode">
          <button aria-pressed={demo} onClick={() => setDemo(true)}>Demo timers (minutes)</button>
          <button aria-pressed={!demo} onClick={() => setDemo(false)}>Real: 30 days + 7 days grace</button>
        </div>
        <p className="hint">
          {demo
            ? 'Demo: grace starts after 2 minutes of silence, handover 1 minute later. Big sends hold for 30s. Use this to show the whole flow live.'
            : 'Real: grace starts after 30 days with no activity, handover 7 days later. Big sends hold for 48 hours.'}
        </p>
      </Section>

      <Section n="3" title="Kidnap protection">
        <div className="row">
          <F label="Daily limit (ETH)" value={limit} set={setLimit} ph="0.05" />
          <F label="Decoy amount under duress (ETH)" value={decoy} set={setDecoy} ph="0.002" />
        </div>
        <F label="Guardians (NEAR accounts, comma separated)" value={guardians} set={setGuardians} ph="rafi.testnet, noor.testnet" />
        <F label="Trusted ETH addresses: your own Ledger, exchange deposit (optional)" value={trusted} set={setTrusted} ph="0x31Fa…08bD" />
        <p className="hint">
          Sends over the limit, and any contract call, wait {demo ? '30 seconds' : '48 hours'} unless they go to a
          trusted address or a guardian approves. Guardians can approve or cancel. They can never take funds.
        </p>
      </Section>

      <Section n="4" title="Passwords on this device">
        <div className="row">
          <F label="App password" value={pw} set={setPw} type="password" />
          <F label="Repeat app password" value={pw2} set={setPw2} type="password" />
        </div>
        <F label="Duress password (optional, must be different)" value={duressPw} set={setDuressPw} type="password" />
        <p className="hint">
          Each password unlocks its own key on this device. The duress password opens the app exactly like the real
          one, sends only the decoy, locks everything and alerts your guardians. Nothing on your phone shows which
          password is which.
        </p>
      </Section>

      {err && <div className="err">{err}</div>}
      <div className="row center">
        <button className="btn accent big" disabled={busy} onClick={submit}>
          {busy ? 'Waiting for your wallet…' : `Create will · ${deposit === null ? '…' : Number(formatUnits(deposit, 24)).toFixed(2)} NEAR storage`}
        </button>
        <span className="hint">Your wallet asks you to approve two things: adding the app keys, and creating the will.</span>
        {hasVault(account) && (
          <button className="btn" onClick={() => { forgetVault(account); setErr('Started over. Choose new passwords.') }}>Start over</button>
        )}
      </div>
    </div>
  )
}

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="card plain">
      <div className="row center" style={{ gap: 12 }}>
        <span className="display ink" style={{ fontSize: 22 }}>{n}</span>
        <b style={{ fontSize: 17 }}>{title}</b>
      </div>
      {children}
    </section>
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
