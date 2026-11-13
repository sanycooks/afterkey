// Encrypted key storage on this device.
//
// The owner's vault holds two entries in random order: the app key and the
// duress key, each encrypted with its own password. Nothing in storage says
// which is which. Unlocking tries the password against both, so the duress
// password opens the app exactly the way the real one does.

export type KeyMode = 'normal' | 'duress'
export interface Unlocked {
  secretKey: string
  mode: KeyMode
}
interface Entry {
  salt: string
  iv: string
  ct: string
}
interface Vault {
  will: string
  entries: Entry[]
}

const enc = new TextEncoder()
const dec = new TextDecoder()
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

async function derive(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: 310_000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

async function seal(password: string, payload: Unlocked): Promise<Entry> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await derive(password, salt)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)))
  return { salt: b64(salt), iv: b64(iv), ct: b64(ct) }
}

async function tryOpen(e: Entry, password: string): Promise<Unlocked | null> {
  try {
    const key = await derive(password, unb64(e.salt))
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, key, unb64(e.ct))
    return JSON.parse(dec.decode(pt)) as Unlocked
  } catch {
    return null
  }
}

const slot = (account: string) => `afterkey:vault:${account}`

export async function createVault(
  account: string,
  will: string,
  appKey: { secretKey: string; password: string },
  duress?: { secretKey: string; password: string },
) {
  if (duress && duress.password === appKey.password) throw new Error('The duress password must be different')
  const entries = [await seal(appKey.password, { secretKey: appKey.secretKey, mode: 'normal' })]
  if (duress) entries.push(await seal(duress.password, { secretKey: duress.secretKey, mode: 'duress' }))
  if (Math.random() < 0.5) entries.reverse()
  localStorage.setItem(slot(account), JSON.stringify({ will, entries } satisfies Vault))
}

export function hasVault(account: string): boolean {
  return localStorage.getItem(slot(account)) !== null
}

export async function unlock(account: string, password: string): Promise<Unlocked | null> {
  const raw = localStorage.getItem(slot(account))
  if (!raw) return null
  const v = JSON.parse(raw) as Vault
  // Try every entry so both passwords take the same time.
  const results = await Promise.all(v.entries.map((e) => tryOpen(e, password)))
  return results.find((r) => r !== null) ?? null
}

export function forgetVault(account: string) {
  localStorage.removeItem(slot(account))
}

// Guardians and heirs only need a plain key for the will they're linked to.
const roleSlot = (account: string, will: string) => `afterkey:role:${account}:${will}`
export function saveRoleKey(account: string, will: string, secretKey: string) {
  localStorage.setItem(roleSlot(account, will), secretKey)
}
export function loadRoleKey(account: string, will: string): string | null {
  return localStorage.getItem(roleSlot(account, will))
}
