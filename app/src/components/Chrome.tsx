import type { ReactNode } from 'react'
import { usePrefs } from '../lib/prefs'

export function Logo() {
  return (
    <a href="#/" style={{ display: 'flex', alignItems: 'center', gap: 10, textDecoration: 'none', padding: '8px 0' }}>
      <svg width="24" height="24" viewBox="0 0 28 28" aria-hidden="true">
        <rect x="1" y="1" width="26" height="26" fill="none" style={{ stroke: 'var(--text)' }} strokeWidth="2" />
        <polyline points="4,15 10,15 12,7 15,21 17,15 24,15" fill="none" style={{ stroke: 'var(--accent-ink)' }} strokeWidth="2.4" />
      </svg>
      <span className="display" style={{ fontSize: 16 }}>afterkey</span>
    </a>
  )
}

export function ThemeSwitch() {
  const { theme, setTheme } = usePrefs()
  return (
    <div className="seg" role="group" aria-label="Theme">
      <button aria-pressed={theme === 'dark'} onClick={() => setTheme('dark')}>Dark</button>
      <button aria-pressed={theme === 'white'} onClick={() => setTheme('white')}>White</button>
    </div>
  )
}

export function MotionSwitch() {
  const { motion, setMotion } = usePrefs()
  return (
    <button
      className="btn"
      style={{ minHeight: 44, fontSize: 12 }}
      aria-pressed={!motion}
      onClick={() => setMotion(!motion)}
      title="Turn animations on or off"
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
        <polyline points="1,9 4,9 6,3 9,13 11,9 15,9" fill="none" stroke="currentColor" strokeWidth="1.6" />
        {!motion && <line x1="2" y1="14" x2="14" y2="2" stroke="currentColor" strokeWidth="1.6" />}
      </svg>
      {motion ? 'Animations on' : 'Animations off'}
    </button>
  )
}

export function TopBar({ links, right }: { links?: ReactNode; right?: ReactNode }) {
  return (
    <header className="wrap">
      <div className="row between center" style={{ padding: '14px 0', borderBottom: '1px solid var(--line)' }}>
        <div className="row center" style={{ gap: 26 }}>
          <Logo />
          {links}
        </div>
        <div className="row center" style={{ gap: 10 }}>
          <ThemeSwitch />
          <MotionSwitch />
          {right}
        </div>
      </div>
    </header>
  )
}

const BEAT =
  '0,80 90,80 100,30 112,120 122,80 260,80 270,50 280,110 290,80 420,80 430,20 442,130 452,80 600,80 610,45 620,115 630,80 760,80 770,28 782,128 792,80 930,80 940,55 950,108 960,80 1090,80 1100,22 1112,130 1122,80 1260,80 1270,48 1280,112 1290,80 1440,80'

/** The heartbeat line. `flat` draws the grace-period flatline. */
export function Pulse({ height = 140, color = 'var(--accent-ink)', flat = false, speed = 4.5, label }: {
  height?: number
  color?: string
  flat?: boolean
  speed?: number
  label?: string
}) {
  const pts = flat ? '0,80 1440,80' : BEAT
  return (
    <svg viewBox="0 0 1440 150" width="100%" height={height} preserveAspectRatio="none" role="img" aria-label={label ?? 'Heartbeat of wallet activity'}>
      <polyline fill="none" style={{ stroke: 'var(--pulse-dim)' }} strokeWidth="2" points={pts} />
      <polyline
        fill="none"
        style={{ stroke: color, animation: `ak-run ${speed}s linear infinite` }}
        strokeWidth="2.5"
        strokeDasharray={flat ? '6 6' : '380 2220'}
        points={pts}
      />
    </svg>
  )
}

export function Countdown({ ms }: { ms: number }) {
  return <>{fmtDuration(ms)}</>
}

export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400)
  const p = (n: number) => String(n).padStart(2, '0')
  const hms = `${p(Math.floor((s % 86400) / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`
  return d > 0 ? `${d}d ${hms}` : hms
}

export const short = (a: string, n = 6) => (a.length > n * 2 + 2 ? `${a.slice(0, n)}…${a.slice(-4)}` : a)
