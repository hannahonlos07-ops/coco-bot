# PandaDoc → Discord contract notifier

Notifies your team in Discord about contract status:

- **✅ Signed** — the moment a client finishes signing a PandaDoc contract, it
  posts a message with the client, amount, and time.
- **⏰ Not signed yet** — if a contract sits unsigned longer than a threshold
  (default **8 hours**), it posts a follow-up reminder. Once per contract.

This version is **one plain JavaScript file, no dependencies, no build step** —
Node runs it directly, so it deploys anywhere with zero fuss.

---

## Files (that's all there is)

```
index.js         ← the whole bot
package.json
.env.example
README.md
```

## The 4 values you'll need

| # | Value | Where to get it |
|---|-------|-----------------|
| 1 | **Bot Token** | discord.com/developers → your app → **Bot** → Reset Token |
| 2 | **Channel ID** | Discord → Settings → Advanced → **Developer Mode ON**, then right-click the channel → Copy Channel ID |
| 3 | **PandaDoc API Key** | PandaDoc → Settings → **API** |
| 4 | **Shared password** | You invent it (e.g. `MyContractBot-9f3Kq7`) |

---

## Setup

### 1. Put the files in your own GitHub repo
Create a new empty repo (github.com → **New**), then **Add file → Upload files**
and drop in `index.js`, `package.json`, `.env.example`, `README.md`. Commit.
(Only 4 files at the top level — nothing to get wrong.)

### 2. Deploy on Railway
1. railway.app → **New Project → Deploy from GitHub repo** → pick your repo.
2. It should start on its own. (If you set a Start Command, use `npm start`.)
3. **Variables** tab → add:

   | Name | Value |
   |------|-------|
   | `DISCORD_BOT_TOKEN` | value **1** |
   | `DISCORD_NOTIFY_CHANNEL_ID` | value **2** |
   | `PANDADOC_API_KEY` | value **3** |
   | `PANDADOC_WEBHOOK_SHARED_KEY` | value **4** |
   | `PANDADOC_REMINDER_HOURS` | `8` (or `5`) |

4. **Settings → Networking → Generate Domain.** Copy the address.
5. Check **Deploy Logs** for `pandadoc->discord worker listening on`. Visit
   `<your-address>/health` — it should say `pandadoc->discord worker ok`.

### 3. Point PandaDoc at it
1. PandaDoc → Settings → **API → Webhooks** → add a webhook.
2. **URL:** your Railway address **+ `/pandadoc/webhook`**, e.g.
   `https://your-app.up.railway.app/pandadoc/webhook`
3. **Events:** check **Document state changed** (`document_state_changed`).
4. **Include in payload:** check **Recipients** and **Pricing** (so messages
   show the client name and amount).
5. **Shared Key:** paste value **4** — the same one in Railway.
6. Save.

### 4. Test it
There's usually no "send test" button — just push a real contract through:
send a contract to yourself, sign it, and within seconds you'll get the
`✅ Contract signed` message in Discord. Watch Railway's logs to see events
arrive.

---

## Notes

- Change the reminder window with `PANDADOC_REMINDER_HOURS` (e.g. `5`).
- Add `DISCORD_NOTIFY_ROLE_ID` to @mention a team role on every alert.
- Prefer a channel webhook over the bot? Set `DISCORD_WEBHOOK_URL` and skip the
  bot token + channel ID.
- Test the Discord side locally without PandaDoc: copy `.env.example` to `.env`,
  fill in the Discord values, then run `npm run test-notify`.

## How it works

- **Signed** = a PandaDoc webhook (`document_state_changed` → `document.completed`)
  hits `POST /pandadoc/webhook`; the bot posts to Discord.
- **Not signed** = every `PANDADOC_POLL_INTERVAL_MINUTES` the bot asks the
  PandaDoc API for contracts still in `sent`/`viewed` and messages Discord about
  any older than the threshold. No database — PandaDoc is the source of truth.
