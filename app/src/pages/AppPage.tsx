import { useEffect, useState } from 'react'
import { TopBar } from '../components/Chrome'
import { willOf } from '../lib/near'
import { useWill } from '../lib/useWill'
import { hasVault, type Unlocked } from '../lib/vault'
import { activeAccount, onAccountChange, openWalletModal, signOut } from '../lib/wallet'
import { Dashboard, RecoverDevice, Unlock } from './Owner'
import { Guardian, Heir } from './Roles'
import Setup from './Setup'

type Tab = 'mine' | 'guard' | 'heir'

export default function AppPage() {
  const [account, setAccount] = useState<string | null>(null)
  const [checked, setChecked] = useState(false)
  const [tab, setTab] = useState<Tab>(() => (location.hash.includes('guard') ? 'guard' : location.hash.includes('heir') ? 'heir' : 'mine'))

  useEffect(() => {
    let sub: { unsubscribe: () => void } | undefined
    activeAccount().then((a) => { setAccount(a); setChecked(true) }).catch(() => setChecked(true))
    onAccountChange(setAccount).then((s) => (sub = s))
    return () => sub?.unsubscribe()
  }, [])

  const tabs: [Tab, string][] = [['mine', 'My will'], ['guard', 'Guarding'], ['heir', 'Inheriting']]
  return (
    <>
      <TopBar
        links={account && (
          <nav className="row" style={{ gap: 2, fontSize: 14 }}>
            {tabs.map(([id, label]) => (
              <button key={id} className="btn" onClick={() => setTab(id)}
                style={{ border: 0, borderBottom: tab === id ? '2px solid var(--accent-ink)' : '2px solid transparent', fontFamily: "'Inter Tight', system-ui, sans-serif", fontSize: 14, fontWeight: tab === id ? 600 : 400, color: tab === id ? 'var(--text)' : 'var(--sub)' }}>
                {label}
              </button>
            ))}
          </nav>
        )}
        right={account ? (
          <button className="btn mono" title="Sign out" onClick={() => signOut().then(() => setAccount(null))}>{account}</button>
        ) : (
          <button className="btn accent" onClick={openWalletModal}>Connect NEAR wallet</button>
        )}
      />
      <main className="wrap">
        {!checked ? null : !account ? <Connect /> : tab === 'mine' ? <Mine account={account} /> : tab === 'guard' ? <Guardian account={account} /> : <Heir account={account} />}
      </main>
    </>
  )
}

function Connect() {
  return (
    <div className="col" style={{ padding: '90px 0', gap: 18, maxWidth: 620 }}>
      <h1 className="display" style={{ margin: 0, fontSize: 'clamp(32px, 5vw, 52px)' }}>Connect your NEAR wallet</h1>
      <p className="sub" style={{ margin: 0, fontSize: 17, lineHeight: 1.6 }}>
        Your NEAR account owns the will. Heirs and guardians connect with their own accounts to see what's theirs.
        We're on testnet, so nothing here is real money.
      </p>
      <div><button className="btn accent big" onClick={openWalletModal}>Connect NEAR wallet</button></div>
    </div>
  )
}

function Mine({ account }: { account: string }) {
  const [will, setWill] = useState<string | null>(null)
  const [err, setErr] = useState('')
  const [me, setMe] = useState<Unlocked | null>(null)
  const { state, refresh } = useWill(will)

  useEffect(() => {
    setMe(null)
    willOf(account).then(setWill).catch(() => setErr("Couldn't reach NEAR testnet. Check your connection and reload."))
  }, [account])

  if (err) return <div className="err" style={{ marginTop: 40 }}>{err}</div>
  if (!will || state === undefined) return <p className="muted" style={{ padding: 40 }}>Looking for your will…</p>
  if (state === null) return <Setup account={account} will={will} onDone={refresh} />
  if (!hasVault(account)) return <RecoverDevice account={account} will={will} />
  if (!me) return <Unlock account={account} onUnlock={setMe} />
  return <Dashboard account={account} will={will} me={me} />
}
