import { useEffect, useState } from 'react'
import { Pulse, TopBar, fmtDuration } from '../components/Chrome'
import { usePrefs } from '../lib/prefs'

const H2 = ({ children }: { children: React.ReactNode }) => (
  <h2 className="display" style={{ margin: 0, fontSize: 'clamp(30px, 4vw, 44px)', lineHeight: 1.05 }}>{children}</h2>
)

function useLoop() {
  const { motion } = usePrefs()
  const [s, setS] = useState(0)
  const [block, setBlock] = useState(182_394_221)
  useEffect(() => {
    const t = setInterval(() => {
      setBlock((b) => b + 1)
      if (motion) setS((x) => (x + 1) % 60)
    }, 1000)
    return () => clearInterval(t)
  }, [motion])
  return { s, block, motion }
}

export default function Landing() {
  const { s, block, motion } = useLoop()
  const ph = s < 30 ? 0 : s < 50 ? 1 : 2
  const phase = ['ALIVE', 'GRACE', 'HANDED OVER'][ph]
  const phaseColor = ['var(--accent-ink)', 'var(--amber)', 'var(--orange)'][ph]
  const phaseLabel = ['grace starts in', 'handover in', 'heir has been signing for'][ph]
  const phaseTime = fmtDuration((ph === 0 ? 30 - s : ph === 1 ? 50 - s : s - 50) * 1000)
  const signer = ph === 2 ? 'amina.testnet' : 'alice.testnet'
  const playhead = s < 30 ? (s / 30) * 58.8 : s < 50 ? 58.8 + ((s - 30) / 20) * 13.7 : 72.5 + ((s - 50) / 10) * 27.5
  const seg = (i: number) => (ph === i ? 1 : 0.35)
  const k = Math.floor((s % 14) / 2)
  const f = motion ? s % 24 : 23 // animations off: show the finished story
  const g = s % 12

  const assets: [string, string][] = [
    ['0.5 ETH', 'moved'],
    ['Uniswap LP #48213', 'stuck'],
    ['staked SOL, unbonding', 'stuck'],
    ['points on 6 protocols', 'lost'],
    ['airdrop landing next month', 'lost'],
  ]
  const logs: [number, string, string][] = [
    [3, '00:00', 'That was the duress password. Wallets locked for 7 days.'],
    [5, '00:00', 'rafi.testnet and noor.testnet alerted on Telegram, silently.'],
    [8, '00:01', 'Real 25 ETH transfer held for 48 hours.'],
    [15, '00:40', 'Cancelled by rafi.testnet. Nothing left the wallet.'],
  ]
  const heldMs = (172_800 - 1325 - s) * 1000

  return (
    <div style={{ overflow: 'hidden' }}>
      <TopBar
        links={
          <nav className="row center hide-sm" style={{ gap: 22, fontSize: 14 }}>
            <a href="#how" style={{ textDecoration: 'none', padding: '12px 0' }}>How it works</a>
            <a href="#force" style={{ textDecoration: 'none', padding: '12px 0' }}>If you're forced</a>
            <a href="#roadmap" style={{ textDecoration: 'none', padding: '12px 0' }}>Roadmap</a>
          </nav>
        }
        right={<a className="btn accent" href="#/app">Open app</a>}
      />

      <section className="wrap row center" style={{ gap: 56, padding: '76px 40px 60px' }}>
        <div className="col" style={{ flex: '1.4 1 520px', minWidth: 0, gap: 26 }}>
          <div className="mono muted" style={{ fontSize: 13 }}>Seedless wallets with a dead man's switch, on NEAR</div>
          <h1 className="display" style={{ margin: 0, fontSize: 'clamp(44px, 6.4vw, 74px)', lineHeight: 1.02 }}>
            Your keys die<br />with you.<br />
            <span style={{ background: 'var(--accent)', color: '#0a0b0a', padding: '0 10px' }}>Your wallet</span>
            <br />doesn't.
          </h1>
          <p className="sub" style={{ maxWidth: 560, fontSize: 19, lineHeight: 1.55, margin: 0 }}>
            Use it like any wallet on ETH, SOL and BTC. Stop showing up for the time you choose (30, 90 or 180 days) and the person you picked can sign
            from it, with everything still inside. Get forced to send, and the big money waits.
          </p>
          <div className="row">
            <a className="btn solid big" href="#/app">Create a will</a>
            <a className="btn big" style={{ borderColor: 'var(--text)' }} href="#demo">Watch the 1-min demo</a>
          </div>
        </div>

        <div id="demo" className="card mono" style={{ flex: '1 1 360px', minWidth: 0, padding: 0, gap: 0 }}>
          <div className="row between center muted" style={{ padding: '14px 18px', borderBottom: '1px solid var(--line)', fontSize: 12 }}>
            <span>demo-will.afterkey.testnet</span>
            <span className="row center" style={{ gap: 8 }}><span className="dot ink" style={{ width: 7, height: 7 }} />live · 60s loop</span>
          </div>
          <div className="col" style={{ padding: '22px 18px', gap: 16 }}>
            <div className="display" style={{ fontSize: 26, color: phaseColor, transition: 'color .4s' }}>{phase}</div>
            <div>
              <div className="muted" style={{ fontSize: 12 }}>{phaseLabel}</div>
              <div style={{ fontSize: 44, fontWeight: 700 }}>{phaseTime}</div>
            </div>
            <Pulse height={56} color={phaseColor} flat={ph === 1} speed={2.4} />
            <div className="col" style={{ borderTop: '1px solid var(--line)', paddingTop: 14, gap: 8, fontSize: 13 }}>
              <div className="row between"><span className="muted">owner</span><span>alice.testnet</span></div>
              <div className="row between"><span className="muted">heir</span><span className="orange">amina.testnet</span></div>
              <div className="row between"><span className="muted">who can sign now</span><b style={{ color: phaseColor }}>{signer}</b></div>
            </div>
          </div>
        </div>
      </section>

      <section style={{ borderTop: '1px solid var(--line)', borderBottom: '1px solid var(--line)', position: 'relative' }}>
        <Pulse />
        <div className="mono muted hide-sm" style={{ position: 'absolute', left: 40, bottom: 10, fontSize: 12 }}>each spike is a transaction you signed · it resets the clock</div>
        <div className="mono muted" style={{ position: 'absolute', right: 40, bottom: 10, fontSize: 12 }}>NEAR testnet block #{block.toLocaleString('en-US')}</div>
      </section>

      <section className="wrap row" style={{ gap: 64, paddingTop: 120 }}>
        <div className="col" style={{ flex: '1 1 340px', minWidth: 0, gap: 20 }}>
          <H2>Inherit the wallet, not the coins.</H2>
          <p className="sub" style={{ fontSize: 17, lineHeight: 1.6, margin: 0 }}>
            Most crypto wills sweep your balances to a new address and leave behind anything tied to the old one.
            Afterkey doesn't move the assets. It moves the right to sign, so the heir gets the same address with
            everything in it.
          </p>
          <div className="mono muted" style={{ fontSize: 13 }}>checking 0x7aE2…91c4 after handover<span className="blink">_</span></div>
        </div>
        <div className="mono" style={{ flex: '1.2 1 480px', minWidth: 0 }}>
          <div className="table-row muted" style={{ gridTemplateColumns: '1.6fr 1fr 1fr', fontSize: 12, borderBottom: '1px solid var(--text)', padding: '0 12px 10px' }}>
            <span>inside the wallet</span><span>sweep-style will</span><span>afterkey</span>
          </div>
          {assets.map(([name, sweep], i) => {
            const done = i < k
            return (
              <div key={name} className="table-row" style={{ gridTemplateColumns: '1.6fr 1fr 1fr', padding: '14px 12px', background: i === k - 1 ? 'var(--sel)' : 'transparent', transition: 'background .3s' }}>
                <span>{name}</span>
                <span style={{ color: done && sweep !== 'moved' ? 'var(--red)' : 'var(--muted)' }}>{done ? sweep : '…'}</span>
                <b style={{ color: done ? 'var(--accent-ink)' : 'var(--muted)' }}>{done ? "heir's" : '…'}</b>
              </div>
            )
          })}
        </div>
      </section>

      <section id="how" className="wrap col" style={{ gap: 32, paddingTop: 140 }}>
        <div className="row between" style={{ alignItems: 'flex-end' }}>
          <H2>One rule, enforced by a contract.</H2>
          <span className="mono muted" style={{ fontSize: 13 }}>playing the demo: 30 days = 30s, grace = 20s</span>
        </div>
        <div style={{ position: 'relative' }}>
          <div className="mono" style={{ display: 'flex', height: 58, fontSize: 13, fontWeight: 700, color: '#0a0b0a' }}>
            <div style={{ flex: 30, background: 'var(--accent)', display: 'flex', alignItems: 'center', padding: '0 18px', opacity: seg(0), transition: 'opacity .4s' }}>0 → 30 days · you sign</div>
            <div style={{ flex: 7, background: 'var(--amber-fill)', display: 'flex', alignItems: 'center', padding: '0 12px', opacity: seg(1), transition: 'opacity .4s' }}>+7 · grace</div>
            <div style={{ flex: 14, background: 'var(--orange-fill)', display: 'flex', alignItems: 'center', padding: '0 12px', opacity: seg(2), transition: 'opacity .4s' }}>after · heir signs</div>
          </div>
          <div style={{ position: 'absolute', top: -10, bottom: -10, width: 3, marginLeft: -1, background: 'var(--text)', left: `${playhead}%`, transition: 'left 1s linear' }} />
        </div>
        <div className="row sub" style={{ gap: 40, fontSize: 16, lineHeight: 1.6 }}>
          <p style={{ flex: '30 1 280px', margin: 0, opacity: seg(0) }}>Every transaction you sign through Afterkey resets the clock. You never press a check-in button unless you want to.</p>
          <p style={{ flex: '7 1 220px', margin: 0, opacity: seg(1) }}>Telegram tells you the clock ran out. Sign anything and it's as if nothing happened. Heirs aren't told.</p>
          <p style={{ flex: '14 1 240px', margin: 0, opacity: seg(2) }}>Your heir logs in with their own NEAR account. The contract now signs for them, and only them.</p>
        </div>
      </section>

      <section className="wrap col" style={{ gap: 32, paddingTop: 140 }}>
        <div className="row between" style={{ alignItems: 'flex-end' }}>
          <H2>Nobody holds a key.<br />Including us.</H2>
          <p className="sub" style={{ maxWidth: 460, fontSize: 16, lineHeight: 1.6, margin: 0 }}>
            Your addresses on other chains belong to your will contract, through NEAR Chain Signatures. The contract
            decides who it signs for. Watch it switch when the demo hands over.
          </p>
        </div>
        <div className="card mono row center" style={{ padding: '36px 28px', gap: 0, fontSize: 13, flexDirection: 'row' }}>
          <div className="col" style={{ width: 150, gap: 14 }}>
            <Node on={ph < 2} color="var(--accent-ink)">alice.testnet<br /><small className="muted">owner</small></Node>
            <Node on={ph === 2} color="var(--orange)">amina.testnet<br /><small className="muted">heir</small></Node>
          </div>
          <Flow color={phaseColor} delay={0} />
          <div className="col" style={{ border: '2px solid var(--text)', padding: '18px 16px', width: 200, gap: 6 }}>
            <b>will contract</b>
            <small className="muted">alice.will.testnet · no keys</small>
            <span style={{ fontSize: 12, color: phaseColor }}>signs for: {signer}</span>
          </div>
          <Flow color={phaseColor} delay={0.5} />
          <div className="row center" style={{ border: '1px solid var(--line)', padding: '18px 16px', width: 170, gap: 10 }}>
            <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" style={{ animation: 'ak-spin 6s linear infinite' }}>
              <circle cx="11" cy="3" r="2.5" style={{ fill: 'var(--text)' }} />
              <circle cx="18" cy="15" r="2.5" style={{ fill: 'var(--text)' }} />
              <circle cx="4" cy="15" r="2.5" style={{ fill: 'var(--text)' }} />
            </svg>
            <span>NEAR MPC<br /><small className="muted">signing network</small></span>
          </div>
          <Flow color={phaseColor} delay={1} />
          <div className="col" style={{ width: 150, gap: 8 }}>
            {['ETH 0x7aE2…91c4', 'SOL 9hTq…vX2d', 'BTC tb1q9x…k4m7'].map((x) => (
              <div key={x} style={{ border: '1px solid var(--line)', padding: '8px 10px' }}>{x}</div>
            ))}
          </div>
        </div>
        <div className="row sub" style={{ gap: 32, fontSize: 15, lineHeight: 1.6 }}>
          <p className="grow" style={{ margin: 0 }}><b style={{ color: 'var(--text)' }}>No seed phrase.</b> Nothing to lose, leak or hand over.</p>
          <p className="grow" style={{ margin: 0 }}><b style={{ color: 'var(--text)' }}>No admin key.</b> Each will is its own contract, created with no keys, so its code can never change.</p>
          <p className="grow" style={{ margin: 0 }}><b style={{ color: 'var(--text)' }}>Time is the only trigger.</b> No oracle, no "report a death" button. Our server only sends reminders.</p>
        </div>
      </section>

      <section id="force" className="wrap col" style={{ gap: 32, paddingTop: 140 }}>
        <div className="row between" style={{ alignItems: 'flex-end' }}>
          <H2>If someone forces you<br />to send it all.</H2>
          <p className="sub" style={{ maxWidth: 420, fontSize: 16, lineHeight: 1.6, margin: 0 }}>
            Wrench attacks need the money to move now. Afterkey makes large amounts slow by design, so you can comply
            and stay safe.
          </p>
        </div>
        <div className="row mono" style={{ gap: 24 }}>
          <div className="card" style={{ flex: '1 1 340px', minWidth: 0 }}>
            <span className="muted" style={{ fontSize: 12 }}>what the attacker sees</span>
            <span style={{ fontSize: 14 }}>send 25 ETH · password <span style={{ letterSpacing: 3 }}>{'•'.repeat(Math.min(8, f))}</span></span>
            <span className="display ink" style={{ fontSize: 30 }}>{f < 9 ? 'Sending…' : 'Sent ✓'}</span>
            <span className="sub" style={{ fontSize: 13 }}>A small decoy really leaves, so it looks like it worked.</span>
          </div>
          <div className="card plain" style={{ flex: '1.4 1 460px', minWidth: 0, borderColor: 'var(--red)', gap: 10, fontSize: 14 }}>
            <span className="red" style={{ fontSize: 12 }}>what actually happens</span>
            {logs.map(([at, t, text]) => (
              <div key={text} style={{ display: 'grid', gridTemplateColumns: '70px 1fr', gap: 12, opacity: f >= at ? 1 : 0, transform: `translateY(${f >= at ? 0 : 6}px)`, transition: 'opacity .4s, transform .4s' }}>
                <span className="muted">{t}</span><span>{text}</span>
              </div>
            ))}
          </div>
        </div>

        <Rules title="the rules behind it" rows={[
          ['Daily limit', 'Everyday spending is instant. Anything above it, and any contract call, waits 48 hours, and you or a guardian can cancel.',
            <div key="b" style={{ height: 8, background: 'var(--track)', position: 'relative' }}><div style={{ height: 8, background: 'var(--accent-ink)', animation: 'ak-fillloop 4s ease-in-out infinite', width: '60%' }} /><div style={{ position: 'absolute', left: '60%', top: -5, width: 2, height: 18, background: 'var(--red)' }} /></div>],
          ['Freeze now', 'One tap before a risky meetup, or the moment something feels wrong: nothing big can leave, and undoing it takes 48 hours.',
            <span key="f" className="mono red" style={{ fontSize: 13 }}>{g < 6 ? 'frozen' : 'available: 0.00 ETH'}</span>],
          ['Duress password', 'A second password that pretends to work, locks everything for 7 days and alerts your guardians.',
            <span key="d" className="mono red" style={{ fontSize: 13 }}>{f >= 3 && f < 20 ? 'locked · guardians alerted' : 'armed'}</span>],
          ['Settings are slow too', 'Raising the limit or removing a guardian takes 48 hours. Tightening is instant. Nobody can make you switch protection off.',
            <span key="s" className="mono amber" style={{ fontSize: 13 }}>applies in {fmtDuration(heldMs)}</span>],
        ]} />
        <Rules title="when you need a big amount yourself" rows={[
          ['Schedule it', 'Request the transfer. After 48 hours it is released and goes out, by itself if a keeper runs, or with one tap.', <span key="a" className="mono amber" style={{ fontSize: 13 }}>releases in {fmtDuration(heldMs - 7200_000)}</span>],
          ['Trusted address', 'Your own Ledger or exchange deposit. Any amount, straight away. A new address takes 48 hours to become trusted.', <span key="b" className="mono ink" style={{ fontSize: 13 }}>{g < 6 ? 'sent to Ledger ✓' : 'instant'}</span>],
          ['Guardian approval', 'Someone you trust approves from their own account. An attacker would need both of you.', <span key="c" className="mono" style={{ fontSize: 13, color: g < 4 ? 'var(--amber)' : 'var(--accent-ink)' }}>{g < 4 ? 'asking rafi…' : g < 8 ? 'approved by rafi ✓' : 'sent ✓'}</span>],
        ]} />
      </section>

      <section id="roadmap" className="wrap col" style={{ gap: 28, paddingTop: 140 }}>
        <H2>Roadmap</H2>
        <div className="roadmap">
          {ROADMAP.map(([when, label, items]) => <RoadCol key={when} when={when} label={label} items={items} />)}
        </div>
      </section>

      <section className="wrap row between" style={{ alignItems: 'flex-end', padding: '140px 40px 30px', gap: 32 }}>
        <h2 className="display" style={{ margin: 0, fontSize: 'clamp(36px, 5vw, 64px)', lineHeight: 1.02 }}>Set it up once.<br />Then forget it exists.</h2>
        <a className="btn accent big" href="#/app">Create a will</a>
      </section>
      <div className="wrap"><Pulse height={60} speed={6} /></div>
      <footer className="wrap row between mono muted" style={{ fontSize: 12, padding: '24px 40px 40px', borderTop: '1px solid var(--line)' }}>
        <span>afterkey · testnet · unaudited, don't use real funds yet</span>
        <span>built on NEAR</span>
      </footer>
    </div>
  )
}

function Node({ on, color, children }: { on: boolean; color: string; children: React.ReactNode }) {
  return (
    <div style={{ border: `1px solid ${on ? color : 'var(--line)'}`, padding: '10px 12px', opacity: on ? 1 : 0.4, transition: 'opacity .4s, border-color .4s' }}>
      {children}
    </div>
  )
}

function Flow({ color, delay }: { color: string; delay: number }) {
  return (
    <div style={{ flex: '1 1 50px', minWidth: 30, position: 'relative', height: 2, background: 'var(--line)' }}>
      <div style={{ position: 'absolute', top: -4, width: 10, height: 10, marginLeft: -5, background: color, animation: `ak-flow 1.6s linear ${delay}s infinite` }} />
    </div>
  )
}

const ROADMAP: ['now' | 'next' | 'later', string, string[]][] = [
  ['now', 'Live on testnet', ['ETH, SOL, BTC wallets', 'No seed phrase', '30 / 90 / 180-day timers', 'Heir gets tokens', 'Heir uses dApps', 'Telegram alerts', 'Daily limit', '48h hold', 'Freeze now', 'Duress password', 'Guardian playbook', 'Trusted addresses', 'Guardian approval', 'Scheduled sends', 'WalletConnect', 'Device recovery']],
  ['next', 'Next', ['Guardian pauses the clock', '2-of-3 guardians', 'Backup heir', '% splits', 'Notes for heirs', 'Early handover', 'Gas for heirs']],
  ['later', 'Later', ['SOL & BTC sends', 'dApp login signing', 'Sealed will', 'Claim links', 'Sweep an old wallet', 'Audit', 'Mainnet']],
]

function RoadCol({ when, label, items }: { when: string; label: string; items: string[] }) {
  const [open, setOpen] = useState(false)
  const shown = open ? items : items.slice(0, 3)
  return (
    <div className={`road-col road-${when}`}>
      <div className="row center mono" style={{ gap: 8, fontSize: 13, fontWeight: 700 }}>
        {when === 'now' && <span className="dot" />}{label}
      </div>
      <div className="col" style={{ gap: 8 }}>
        {shown.map((x) => <span key={x} className="chip">{x}</span>)}
      </div>
      {items.length > 3 && (
        <button className="road-more mono" onClick={() => setOpen(!open)}>{open ? 'See less' : `See ${items.length - 3} more`}</button>
      )}
    </div>
  )
}

function Rules({ title, rows }: { title: string; rows: [string, string, React.ReactNode][] }) {
  return (
    <div className="col" style={{ gap: 0, fontSize: 16 }}>
      <div className="mono muted" style={{ fontSize: 12, paddingBottom: 12, borderBottom: '1px solid var(--text)' }}>{title}</div>
      {rows.map(([name, text, live]) => (
        <div key={name} className="table-row rule-row">
          <b style={{ fontWeight: 600, gridArea: 'name' }}>{name}</b>
          <span className="sub" style={{ gridArea: 'text' }}>{text}</span>
          <div style={{ gridArea: 'live', minWidth: 110 }}>{live}</div>
        </div>
      ))}
    </div>
  )
}
