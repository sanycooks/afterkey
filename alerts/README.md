# Afterkey alerts (Cloudflare Workers, free)

One deployment serves every Afterkey user. Nobody runs a server.

1. Create a bot: message @BotFather in Telegram → `/newbot` → copy the token.
2. In this folder:

   ```bash
   npm install
   npx wrangler login                        # opens the browser, free Cloudflare account
   npx wrangler kv namespace create KV       # paste the printed id into wrangler.toml
   # in wrangler.toml, set FACTORY to your factory account
   npx wrangler secret put TELEGRAM_TOKEN    # paste the BotFather token
   npx wrangler secret put WEBHOOK_SECRET    # type any long random string, e.g. from: openssl rand -hex 16
   npx wrangler deploy                       # prints https://afterkey-alerts.<you>.workers.dev
   ```

3. Connect Telegram to it, once: open
   `https://afterkey-alerts.<you>.workers.dev/setup?secret=<WEBHOOK_SECRET>`
   It should answer `{"ok":true,...}`.
4. Build the app with `VITE_TELEGRAM_BOT=<bot username>` so its "Get Telegram alerts" buttons point at your bot.

Free-tier fit: one KV read per minute plus a few writes when something changes; up to 40 wills per minute-run.
