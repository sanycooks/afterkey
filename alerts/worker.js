// Afterkey alerts: a Telegram bot on Cloudflare Workers' free tier.
//
// No server to run or pay for. One deployment serves every Afterkey user:
//   * Telegram calls POST /tg/<WEBHOOK_SECRET> whenever someone messages the bot.
//   * A cron trigger runs every minute, reads each watched will from NEAR and sends alerts.
//
// Commands (the app's buttons fill these in through deep links):
//   /start <owner account>   alerts for the owner: grace period, held transfers, new device keys
//   /guard <owner account>   alerts for a guardian: all of that, plus duress lockdowns
//   /heir <owner account>    one message for an heir, when the wallet becomes theirs (never during grace)
//   /stop                    unsubscribe this chat
//
// Duress alerts go to guardians only, never to the owner's chat: if someone is
// holding the owner's phone, that message would put the owner in danger.
//
// Storage: one KV key "subs" (who watches what) and one "seen" (what was already
// announced). Each is written only when it changes, which keeps well inside the free tier.

export default {
  async fetch(req, env) {
    const url = new URL(req.url)
    if (req.method === 'POST' && url.pathname === `/tg/${env.WEBHOOK_SECRET}`) {
      await onUpdate(await req.json(), env)
      return new Response('ok')
    }
    // One-time setup: visit /setup?secret=<WEBHOOK_SECRET> after deploying.
    if (url.pathname === '/setup' && url.searchParams.get('secret') === env.WEBHOOK_SECRET) {
      const r = await tg(env, 'setWebhook', { url: `${url.origin}/tg/${env.WEBHOOK_SECRET}`, allowed_updates: ['message'] })
      return Response.json(r)
    }
    // The optional keeper reads which wills to look after from here.
    if (url.pathname === '/wills') {
      const subs = await load(env, 'subs', [])
      return Response.json([...new Set(subs.map((s) => s.will))])
    }
    return new Response('Afterkey alerts', { status: url.pathname === '/' ? 200 : 404 })
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(checkAll(env))
  },
}

// ---------------------------------------------------------------- storage

async function load(env, key, fallback) {
  return (await env.KV.get(key, 'json')) ?? fallback
}
async function saveIfChanged(env, key, value, before) {
  const s = JSON.stringify(value)
  if (s !== before) await env.KV.put(key, s)
}

// ---------------------------------------------------------------- telegram

function tg(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => r.json()).catch(() => null)
}
const say = (env, chatId, text) => tg(env, 'sendMessage', { chat_id: chatId, text, disable_web_page_preview: true })

/** Deep links can't carry dots, so the app sends "o" or "g" + base64url(owner account). */
function decodeDeepLink(arg) {
  const m = /^([ogh])([A-Za-z0-9_-]+)$/.exec(arg ?? '')
  if (!m) return null
  try {
    const b64 = m[2].replace(/-/g, '+').replace(/_/g, '/')
    const owner = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
    return /^[a-z0-9._-]{2,64}$/.test(owner) ? { role: { g: 'guardian', h: 'heir', o: 'owner' }[m[1]], owner } : null
  } catch {
    return null
  }
}

async function onUpdate(u, env) {
  const m = u.message
  if (!m?.text) return
  const chatId = m.chat.id
  const [cmd, arg] = m.text.trim().split(/\s+/)
  if (cmd === '/stop') {
    const subs = await load(env, 'subs', [])
    await env.KV.put('subs', JSON.stringify(subs.filter((s) => s.chatId !== chatId)))
    return say(env, chatId, 'Unsubscribed. Send /start <account> to watch a will again.')
  }
  if (cmd !== '/start' && cmd !== '/guard' && cmd !== '/heir') return

  const link = cmd === '/start' ? decodeDeepLink(arg) : null
  const role = link?.role ?? (cmd === '/guard' ? 'guardian' : cmd === '/heir' ? 'heir' : 'owner')
  const target = link?.owner ?? arg
  if (!target) {
    return say(env, chatId, 'Send /start <your NEAR account> for your own will, or /guard <their NEAR account> if you are a guardian.')
  }
  const will = target.endsWith(`.${env.FACTORY}`) ? target : await view(env, env.FACTORY, 'will_of', { owner: target }).catch(() => null)
  const state = will && (await view(env, will, 'get_state').catch(() => null))
  if (!state) return say(env, chatId, `No Afterkey will found for ${target}.`)

  const subs = await load(env, 'subs', [])
  const next = subs.filter((s) => !(s.chatId === chatId && s.will === will))
  next.push({ chatId, will, role })
  await env.KV.put('subs', JSON.stringify(next))
  return say(env, chatId, role === 'guardian'
    ? `You're watching ${state.owner}'s will as a guardian. You'll hear about held transfers, new device keys, the grace period, and duress lockdowns.`
    : role === 'heir'
      ? `Got it. If ${state.owner}'s wallets ever pass to you, you'll get one message here with what to do. Nothing before that.`
      : `You're watching your will. You'll hear before your grace period starts, when it starts, and about every held transfer or new device key.`)
}

// ---------------------------------------------------------------- NEAR

async function view(env, contract, method, args = {}) {
  const r = await fetch(env.NEAR_RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 'ak', method: 'query',
      params: { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: btoa(JSON.stringify(args)) },
    }),
  }).then((x) => x.json())
  if (r.error || r.result?.error) throw new Error(JSON.stringify(r.error ?? r.result.error))
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result.result)))
}

// ---------------------------------------------------------------- alerts

const ms = (ns) => Number(BigInt(ns) / 1_000_000n)
function dur(x) {
  const s = Math.max(0, Math.round(x / 1000))
  if (s >= 86400) return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`
  if (s >= 3600) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  if (s >= 60) return `${Math.floor(s / 60)}m ${s % 60}s`
  return `${s}s`
}
function eth(wei) {
  const w = BigInt(wei)
  const whole = w / 10n ** 18n
  const frac = (w % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '').slice(0, 6)
  return frac ? `${whole}.${frac}` : `${whole}`
}
const describe = (p) =>
  'Eth' in p.request ? `${eth(p.request.Eth.tx.value)} ETH to ${p.request.Eth.tx.to}` : `a ${p.path} request (${p.request.Raw.note || 'no note'})`

async function checkAll(env) {
  const subs = await load(env, 'subs', [])
  const seenRaw = await env.KV.get('seen')
  const seen = seenRaw ? JSON.parse(seenRaw) : {}
  const wills = [...new Set(subs.map((s) => s.will))]
  // The free plan allows 50 outgoing requests per run; stay well under it.
  for (const will of wills.slice(0, 40)) {
    try {
      await checkWill(env, will, subs.filter((s) => s.will === will), seen)
    } catch (e) {
      console.log('check failed', will, e.message)
    }
  }
  for (const w of Object.keys(seen)) if (!wills.includes(w)) delete seen[w]
  await saveIfChanged(env, 'seen', seen, seenRaw)
}

async function checkWill(env, will, subs, seenAll) {
  const s = await view(env, will, 'get_state')
  const seen = (seenAll[will] ??= { phase: 'alive', pending: [], changes: [], locked: '0', warned: '' })
  const owners = subs.filter((x) => x.role === 'owner')
  const guards = subs.filter((x) => x.role === 'guardian')
  const heirs = subs.filter((x) => x.role === 'heir')
  const out = []
  const toOwners = (t) => owners.forEach((x) => out.push([x.chatId, t]))
  const toGuards = (t) => guards.forEach((x) => out.push([x.chatId, t]))
  const now = ms(s.now)
  const graceAt = ms(s.grace_at)
  const handoverAt = ms(s.handover_at)

  // Early warning when 10% of the alive period is left.
  const warnAt = graceAt - Math.max((Number(s.alive_secs) * 1000) / 10, 30_000)
  if (s.phase === 'alive' && now >= warnAt && seen.warned !== s.last_beat) {
    seen.warned = s.last_beat
    toOwners(`No activity on your Afterkey wallets lately. Your grace period starts in ${dur(graceAt - now)}. Sign anything, or press "check-in" in the app, to reset it.`)
  }
  if (s.phase !== seen.phase) {
    if (s.phase === 'grace') {
      toOwners(`Your grace period has started. Your heirs take over in ${dur(handoverAt - now)} unless you sign anything. One transaction cancels it, and nobody else is told.`)
      toGuards(`${s.owner}'s will entered its grace period. Handover in ${dur(handoverAt - now)} unless they show activity. You may want to check on them.`)
    } else if (s.phase === 'handed_over') {
      ;[...owners, ...guards].forEach((x) => out.push([x.chatId, `${s.owner}'s will has handed over. Heirs can now sign from their wallets in the Afterkey app (Inheriting tab).`]))
      heirs.forEach((x) => out.push([x.chatId, `${s.owner}'s wallets are now yours. Open the Afterkey app, go to Inheriting, enter ${s.owner}, and you can move everything or use the wallets in any dApp.${env.APP_URL ? ` ${env.APP_URL}/#/app?heir=${s.owner}` : ''}`]))
    }
    seen.phase = s.phase
  }

  // Duress: guardians only.
  if (s.locked_until !== '0' && s.locked_until !== seen.locked) {
    toGuards(`⚠ ${s.owner} used their DURESS password. Their wallets are locked until ${new Date(ms(s.locked_until)).toUTCString()}. They may be in danger right now: check on them in person. Don't approve anything marked "made under duress".`)
  }
  seen.locked = s.locked_until

  for (const p of s.pending) {
    if (seen.pending.includes(p.id)) continue
    seen.pending.push(p.id)
    if (p.status === 'DuressHeld') {
      toGuards(`⚠ Under duress, someone asked to send ${describe(p)}. It's frozen. Don't approve it unless you've confirmed ${s.owner} is safe.`)
    } else {
      toOwners(`Held transfer #${p.id}: ${describe(p)}. It's released in ${dur(ms(p.release_at) - now)}. Not you? Cancel it in the Afterkey app.`)
      toGuards(`${s.owner} queued #${p.id}: ${describe(p)}. Approve or cancel it in the Afterkey app (Guarding tab).`)
    }
  }
  seen.pending = seen.pending.slice(-200)
  for (const c of s.changes) {
    if (seen.changes.includes(c.id)) continue
    seen.changes.push(c.id)
    const key = Object.keys(c.change)[0]
    const text = key === 'AddOwnerKey'
      ? `A new device key was requested for ${s.owner}'s will (change #${c.id}). It activates in ${dur(ms(c.apply_at) - now)}. If ${s.owner} didn't do this, a guardian should block it in the app now.`
      : `${s.owner}'s will: settings change #${c.id} (${key}) applies in ${dur(ms(c.apply_at) - now)}. Guardians can block it.`
    ;[...owners, ...guards].forEach((x) => out.push([x.chatId, text]))
  }
  seen.changes = seen.changes.slice(-200)

  for (const [chatId, text] of out) await say(env, chatId, text)
}
