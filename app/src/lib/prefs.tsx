import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'

type Theme = 'dark' | 'white'
interface Prefs {
  theme: Theme
  motion: boolean
  setTheme: (t: Theme) => void
  setMotion: (m: boolean) => void
}

const Ctx = createContext<Prefs | null>(null)

function initialMotion(): boolean {
  const saved = localStorage.getItem('afterkey:motion')
  if (saved) return saved === 'on'
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function PrefsProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('afterkey:theme') as Theme) || 'dark')
  const [motion, setMotion] = useState<boolean>(initialMotion)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('afterkey:theme', theme)
  }, [theme])
  useEffect(() => {
    document.documentElement.dataset.motion = motion ? 'on' : 'off'
    localStorage.setItem('afterkey:motion', motion ? 'on' : 'off')
  }, [motion])

  return <Ctx.Provider value={{ theme, motion, setTheme, setMotion }}>{children}</Ctx.Provider>
}

export function usePrefs(): Prefs {
  const p = useContext(Ctx)
  if (!p) throw new Error('PrefsProvider missing')
  return p
}

/** Ticks once a second. Keeps counting with animations off: countdowns are information, not decoration. */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}
