import { useCallback, useEffect, useState } from 'react'
import { getState, type WillState } from './near'

/** Polls a will's on-chain state. undefined = loading, null = no will at that account. */
export function useWill(will: string | null | undefined, everyMs = 4000) {
  const [state, setState] = useState<WillState | null | undefined>(undefined)
  const [fetchedAt, setFetchedAt] = useState(0)

  const refresh = useCallback(async () => {
    if (!will) return
    const s = await getState(will)
    setState(s)
    setFetchedAt(Date.now())
  }, [will])

  useEffect(() => {
    setState(undefined)
    if (!will) return
    refresh()
    const t = setInterval(refresh, everyMs)
    return () => clearInterval(t)
  }, [will, everyMs, refresh])

  return { state, refresh, fetchedAt }
}

/**
 * Chain time for a timestamp: the contract reports its own `now`, and we add the
 * time passed since we fetched it. Countdowns then follow the chain clock, not
 * the device clock.
 */
export function chainNowMs(state: WillState, fetchedAt: number, now: number) {
  return Number(BigInt(state.now) / 1_000_000n) + (now - fetchedAt)
}
