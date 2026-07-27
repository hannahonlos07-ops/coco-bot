# PandaDoc → Discord contract notifier

Notifies your team in a Discord channel about contract status, using your
existing Discord bot:

- **✅ Signed** — the moment a client finishes signing a PandaDoc contract,
  it posts a message with the client, amount, and time.
- **⏰ Not signed yet** — if a contract sits unsigned longer than a threshold
  (default **8 hours**), it posts a follow-up reminder. Once per contract.

You only run one thing: `npm run pandadoc`. Host it on any always-on service
(Railway is the easy button).

---

## What you'll collect (4 values)

| # | Value | Where to get it |
|---|-------|-----------------|
| 1 | **Bot Token** | discord.com/developers → your app → **Bot** → Reset Token → Copy |
| 2 | **Channel ID** | Discord → Settings → Advanced → **Developer Mode ON**, then right-click the channel → Copy Channel ID |
| 3 | **PandaDoc API Key** | PandaDoc → Settings → **API** |
| 4 | **Shared password** | You invent it (e.g. `MyContractBot-9f3Kq7`) — used to verify webhooks |

You'll paste 1–4 into your host as **Variables**, the host gives you a **web
address**, and you paste that address back into PandaDoc.

---

## Setup

### 1. Get this code into your own GitHub

1. Create a new **empty** repo on your personal GitHub (github.com → **New**).
   Don't add a README or .gitignore — leave it empty.
2. On the new repo's page, click **"uploading an existing file"**.
3. Unzip this project, then drag **all of its files and folders** into the
   upload box (keep the folder structure). Commit.

### 2. Deploy it on Railway

1. Go to **railway.app**, log in with your GitHub account.
2. **New Project → Deploy from GitHub repo →** pick your new repo.
   - If it's not listed, click **"Configure GitHub App"** and grant Railway
     access to it.
3. Open the service → **Settings** → set **Start Command** to:
   ```
   npm run pandadoc
   ```
4. Open the **Variables** tab and add:

   | Name | Value |
   |------|-------|
   | `DISCORD_BOT_TOKEN` | value **1** |
   | `DISCORD_NOTIFY_CHANNEL_ID` | value **2** |
   | `PANDADOC_API_KEY` | value **3** |
   | `PANDADOC_WEBHOOK_SHARED_KEY` | value **4** |
   | `PANDADOC_REMINDER_HOURS` | `8` (or `5`) |

5. **Settings → Networking → Generate Domain.** Copy the address it gives you
   (e.g. `https://your-app.up.railway.app`).
6. Check the **Deploy Logs** — you should see
   `pandadoc->discord worker listening on`. Visiting `<your-address>/health`
   in a browser should say `pandadoc->discord worker ok`.

> Your bot must already be a member of the server that channel is in, with
> permission to post (Administrator covers this).

### 3. Point PandaDoc at it

1. PandaDoc → Settings → **API / Webhooks** → add a webhook.
2. **URL:** your Railway address **+ `/pandadoc/webhook`**, e.g.
   `https://your-app.up.railway.app/pandadoc/webhook`
3. **Events:** check **`document_state_changed`**.
4. **Shared Key:** paste value **4** (the same password you set in Railway).
5. Save, then use PandaDoc's **"Send test"** — check your Discord channel and
   the Railway logs.

Done. Signatures now show up in Discord within seconds, and contracts left
unsigned for 8 hours get a follow-up nudge.

---

## Tuning

- Change the reminder window with `PANDADOC_REMINDER_HOURS` (e.g. `5`).
- Add `DISCORD_NOTIFY_ROLE_ID` to @mention a team role on every alert.
- Prefer a channel webhook over the bot? Set `DISCORD_WEBHOOK_URL` instead of
  the bot token + channel ID.

## Test the Discord side without PandaDoc

If you have Node installed locally: copy `.env.example` to `.env`, fill in the
Discord values, then:

```
npm install
npm run test-notify
```

Two sample messages should land in your channel.

## How it works (for the curious)

- **Signed** = a PandaDoc webhook (`document_state_changed` → `document.completed`)
  hits `POST /pandadoc/webhook`; the worker posts to Discord.
- **Not signed** = every `PANDADOC_POLL_INTERVAL_MINUTES` the worker asks the
  PandaDoc API for contracts still in `sent`/`viewed`, and messages Discord
  about any older than the threshold. No database — PandaDoc is the source of
  truth.
