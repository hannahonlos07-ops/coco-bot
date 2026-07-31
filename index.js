// PandaDoc -> Discord contract notifier — single self-contained file, plain
// JavaScript, zero dependencies. Node runs this directly (node index.js).
//
//   1. Webhook server — PandaDoc calls POST /pandadoc/webhook on every document
//      state change; when a contract reaches "document.completed" (signed), it
//      posts a "✅ signed" message to Discord immediately.
//   2. Reminder poller — every PANDADOC_POLL_INTERVAL_MINUTES it asks the
//      PandaDoc API for contracts still in sent/viewed (unsigned) and reminds
//      about ones that JUST crossed the unsigned threshold.
//
// Flood-safe design: it only reminds about a contract in a short window right
// after it passes the threshold — so your existing backlog of old unsigned
// contracts is never announced, and a redeploy/restart can't re-flood. Plus a
// hard per-cycle cap and Discord rate-limit handling as backstops.
//
// Start:  npm start   (or: node index.js)
// Test the Discord side without PandaDoc:  npm run test-notify

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

// --- tiny .env loader (only used locally; hosts inject env vars directly) ----
function loadDotEnv(path = ".env") {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    const val = t.slice(eq + 1).trim();
    if (!(key in process.env)) process.env[key] = val;
  }
}
loadDotEnv();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? "3000");
const WEBHOOK_PATH = "/pandadoc/webhook";
const REMINDER_HOURS = Number(process.env.PANDADOC_REMINDER_HOURS ?? "8");
const POLL_INTERVAL_MINUTES = Number(process.env.PANDADOC_POLL_INTERVAL_MINUTES ?? "30");
// Never remind more than this many contracts in a single poll cycle — a hard
// backstop against any accidental flood.
const MAX_REMINDERS_PER_CYCLE = Number(process.env.PANDADOC_MAX_REMINDERS_PER_CYCLE ?? "10");
// Space out Discord messages a little so we don't trip Discord's rate limit.
const DISCORD_SEND_SPACING_MS = 1200;
const PANDADOC_API_BASE = "https://api.pandadoc.com/public/v1";

// A contract is only "newly overdue" for a short window after it passes the
// threshold: from REMINDER_HOURS to REMINDER_HOURS + this window. Anything
// older than that is backlog and is never announced. The window spans two poll
// cycles so a contract can't slip between polls unnoticed.
const REMIND_WINDOW_MS = POLL_INTERVAL_MINUTES * 2 * 60 * 1000;

// Status codes for the PandaDoc list endpoint's `status` filter.
const STATUS_SENT = 1;
const STATUS_VIEWED = 5;

// End-of-day digest: once a day at DIGEST_HOUR (Eastern), post a single list of
// every contract still unsigned. Set PANDADOC_DIGEST_ENABLED=false to turn off.
const DIGEST_ENABLED = (process.env.PANDADOC_DIGEST_ENABLED ?? "true").toLowerCase() !== "false";
const DIGEST_HOUR = Number(process.env.PANDADOC_DIGEST_HOUR ?? "20"); // 20 = 8 PM
const DIGEST_TZ = process.env.PANDADOC_DIGEST_TIMEZONE ?? "America/New_York";
const DIGEST_MAX_LIST = 40; // cap names in one message; note the rest
let lastDigestDate = null; // Eastern date string we last sent a digest for

// Contracts already reminded this process lifetime, so consecutive polls that
// both see the same contract in-window don't double-send.
const remindedDocIds = new Set();

// Contracts already announced as signed, so duplicate "completed" webhook
// events (PandaDoc sends more than one) don't post the message twice.
const completedNotifiedIds = new Set();

// --------------------------------------------------------------------------
// Formatting helpers (no libraries — Intl handles the timezone)
// --------------------------------------------------------------------------
function formatEastern(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(d);
  return `${s} ET`;
}

function timeAgo(iso) {
  if (!iso) return "a while";
  const then = new Date(iso).getTime();
  if (isNaN(then)) return "a while";
  const hours = (Date.now() - then) / 3_600_000;
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60));
    return `about ${mins} minute${mins === 1 ? "" : "s"}`;
  }
  const r = Math.round(hours);
  return `about ${r} hour${r === 1 ? "" : "s"}`;
}

function formatMoney(total) {
  if (!total || !total.amount) return "";
  const num = Number(total.amount);
  if (!isFinite(num) || num === 0) return "";
  const currency = total.currency || "USD";
  if (currency === "USD") {
    return num.toLocaleString("en-US", { style: "currency", currency: "USD" });
  }
  return `${num.toLocaleString("en-US", { minimumFractionDigits: 2 })} ${currency}`;
}

function primaryRecipient(doc) {
  const recipients = doc.recipients ?? [];
  return recipients.find((r) => r.has_completed === false) ?? recipients[0];
}

function recipientLabel(r) {
  if (!r) return "the recipient";
  const name = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
  if (name && r.email) return `${name} (${r.email})`;
  return name || r.email || "the recipient";
}

// --------------------------------------------------------------------------
// Message wording
// --------------------------------------------------------------------------
function signedMessage(doc) {
  const who = recipientLabel(primaryRecipient(doc));
  const amount = formatMoney(doc.grand_total);
  const when = formatEastern(doc.date_completed) || formatEastern(doc.date_modified);
  const lines = [
    `✅ **Contract signed** — ${doc.name}`,
    `${who} just completed and signed the contract.`,
  ];
  if (amount) lines.push(`💰 Amount: ${amount}`);
  if (when) lines.push(`🕑 Completed: ${when}`);
  return lines.join("\n");
}

function reminderMessage(doc) {
  const who = recipientLabel(primaryRecipient(doc));
  const amount = formatMoney(doc.grand_total);
  const sentIso = doc.date_modified || doc.date_created;
  const ago = timeAgo(sentIso);
  const viewed = doc.status === "document.viewed";
  const lines = [
    `⏰ **Contract not signed yet** — ${doc.name}`,
    `${who} received this ${ago} ago and ${viewed ? "has viewed but not signed" : "hasn't opened or signed"} it. Please follow up.`,
  ];
  if (amount) lines.push(`💰 Amount: ${amount}`);
  const when = formatEastern(sentIso);
  if (when) lines.push(`🕑 Sent: ${when}`);
  return lines.join("\n");
}

// --------------------------------------------------------------------------
// Discord delivery — with rate-limit (429) handling
// --------------------------------------------------------------------------
async function discordPost(url, headers, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
    if (res.status === 429) {
      let retryAfter = 1;
      try {
        const j = await res.json();
        retryAfter = Number(j.retry_after) || 1;
      } catch {
        /* ignore */
      }
      console.warn(`Discord rate-limited — waiting ${retryAfter}s then retrying`);
      await sleep((retryAfter + 0.25) * 1000);
      continue;
    }
    if (!res.ok) console.error("Discord post failed", res.status, await res.text());
    return;
  }
  console.error("Discord post failed after retries (still rate-limited)");
}

async function notifyDiscord(content) {
  const roleId = process.env.DISCORD_NOTIFY_ROLE_ID;
  const body = {};
  if (roleId) {
    body.content = `<@&${roleId}> ${content}`.slice(0, 2000);
    body.allowed_mentions = { roles: [roleId] };
  } else {
    body.content = content.slice(0, 2000);
    body.allowed_mentions = { parse: [] }; // don't accidentally ping anyone
  }

  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (webhookUrl) {
    await discordPost(webhookUrl, { "Content-Type": "application/json" }, body);
    return;
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_NOTIFY_CHANNEL_ID;
  if (!token || !channelId) {
    throw new Error(
      "No Discord destination configured — set DISCORD_WEBHOOK_URL, or DISCORD_BOT_TOKEN + DISCORD_NOTIFY_CHANNEL_ID"
    );
  }
  await discordPost(
    `https://discord.com/api/v10/channels/${channelId}/messages`,
    { "Content-Type": "application/json", Authorization: `Bot ${token}` },
    body
  );
}

// --------------------------------------------------------------------------
// PandaDoc API + webhook verification
// --------------------------------------------------------------------------
function verifyPandaDocSignature(rawBody, signature) {
  const sharedKey = process.env.PANDADOC_WEBHOOK_SHARED_KEY;
  if (!sharedKey) {
    console.warn(
      "PANDADOC_WEBHOOK_SHARED_KEY not set — accepting webhook without verification. Set a Shared Key in PandaDoc and this env var to secure it."
    );
    return true;
  }
  if (!signature) return false;
  const expected = crypto.createHmac("sha256", sharedKey).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function pandaGet(path) {
  const key = process.env.PANDADOC_API_KEY;
  if (!key) throw new Error("Missing PANDADOC_API_KEY");
  const res = await fetch(`${PANDADOC_API_BASE}${path}`, {
    headers: { Authorization: `API-Key ${key}` },
  });
  if (!res.ok) throw new Error(`PandaDoc GET ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

async function listDocumentsByStatus(statusCode) {
  const data = await pandaGet(`/documents?status=${statusCode}&count=100&order_by=date_created`);
  return data.results ?? [];
}

async function getDocumentDetails(id) {
  return pandaGet(`/documents/${id}/details`);
}

// --------------------------------------------------------------------------
// Webhook handling
// --------------------------------------------------------------------------
async function handleWebhookEvents(events) {
  for (const evt of events) {
    const doc = evt?.data;
    if (!doc?.id) continue;
    if (doc.status === "document.completed") {
      if (completedNotifiedIds.has(doc.id)) {
        console.log(`webhook: ${doc.id} completed (duplicate event) — already notified, skipping`);
        continue;
      }
      completedNotifiedIds.add(doc.id);
      remindedDocIds.delete(doc.id);
      console.log(`webhook: ${doc.id} completed — notifying Discord`);
      const enriched = await enrichForSigned(doc);
      await notifyDiscord(signedMessage(enriched));
    } else {
      console.log(`webhook: ${doc.id} -> ${doc.status} (${evt.event}) — no notification`);
    }
  }
}

// The webhook payload can omit the amount (grand_total). When we have API
// access, fetch the full document to fill it in; fall back to the webhook data
// on any error so a notification is never lost.
async function enrichForSigned(doc) {
  if (!process.env.PANDADOC_API_KEY) return doc;
  try {
    const details = await getDocumentDetails(doc.id);
    return { ...doc, ...details };
  } catch (err) {
    console.error(`webhook: couldn't fetch details for ${doc.id}, using webhook data`, err.message ?? err);
    return doc;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// --------------------------------------------------------------------------
// Reminder poller
// --------------------------------------------------------------------------
function outstandingMs(doc) {
  const iso = doc.date_modified || doc.date_created;
  const since = iso ? Date.parse(iso) : NaN;
  return isFinite(since) ? Date.now() - since : 0;
}

// True only for contracts that passed the threshold recently (within the
// remind window) — i.e. genuinely "just went overdue", not old backlog.
function isNewlyOverdue(doc) {
  const thresholdMs = REMINDER_HOURS * 60 * 60 * 1000;
  const age = outstandingMs(doc);
  return age >= thresholdMs && age <= thresholdMs + REMIND_WINDOW_MS;
}

async function sendReminder(doc) {
  let enriched = doc;
  try {
    enriched = await getDocumentDetails(doc.id);
  } catch (err) {
    console.error(`poller: couldn't fetch details for ${doc.id}, using list row`, err.message ?? err);
  }
  await notifyDiscord(reminderMessage(enriched));
}

async function checkOutstandingContracts() {
  try {
    const [sent, viewed] = await Promise.all([
      listDocumentsByStatus(STATUS_SENT),
      listDocumentsByStatus(STATUS_VIEWED),
    ]);
    const outstanding = [...sent, ...viewed];
    const stillOutstanding = new Set(outstanding.map((d) => d.id));
    for (const id of remindedDocIds) {
      if (!stillOutstanding.has(id)) remindedDocIds.delete(id);
    }

    const eligible = outstanding.filter((d) => !remindedDocIds.has(d.id) && isNewlyOverdue(d));

    let count = 0;
    for (const doc of eligible) {
      if (count >= MAX_REMINDERS_PER_CYCLE) {
        console.warn(
          `poller: per-cycle cap (${MAX_REMINDERS_PER_CYCLE}) reached — ${eligible.length - count} remaining will be picked up next cycle`
        );
        break;
      }
      await sendReminder(doc);
      remindedDocIds.add(doc.id);
      count++;
      if (count < eligible.length) await sleep(DISCORD_SEND_SPACING_MS);
    }
    console.log(
      `poller: ${outstanding.length} outstanding, ${eligible.length} newly-overdue, ${count} reminder(s) sent (threshold ${REMINDER_HOURS}h)`
    );
  } catch (err) {
    console.error("poller: cycle failed", err.message ?? err);
  }
}

// On startup, silently mark every contract that is ALREADY overdue so it's
// never announced — belt-and-suspenders on top of the remind-window (which
// already excludes old backlog even if this snapshot fails/rate-limits).
async function seedBaseline() {
  const thresholdMs = REMINDER_HOURS * 60 * 60 * 1000;
  try {
    const [sent, viewed] = await Promise.all([
      listDocumentsByStatus(STATUS_SENT),
      listDocumentsByStatus(STATUS_VIEWED),
    ]);
    let seeded = 0;
    for (const doc of [...sent, ...viewed]) {
      if (outstandingMs(doc) >= thresholdMs) {
        remindedDocIds.add(doc.id);
        seeded++;
      }
    }
    console.log(
      `poller: baseline set — ${seeded} existing overdue contract(s) will NOT be notified. Only contracts that pass ${REMINDER_HOURS}h from now on will trigger a reminder.`
    );
  } catch (err) {
    console.warn(
      "poller: baseline snapshot unavailable (likely rate-limited) — the remind-window still prevents any backlog flood.",
      err.message ?? err
    );
  }
}

// --------------------------------------------------------------------------
// End-of-day "who hasn't signed" digest
// --------------------------------------------------------------------------
function easternHourAndDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: DIGEST_TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return { hour: Number(get("hour")), date: `${get("year")}-${get("month")}-${get("day")}` };
}

// Builds and posts the single end-of-day list of every unsigned contract.
async function sendUnsignedDigest() {
  try {
    const [sent, viewed] = await Promise.all([
      listDocumentsByStatus(STATUS_SENT),
      listDocumentsByStatus(STATUS_VIEWED),
    ]);
    // Oldest first, so the most-overdue agents are at the top of the list.
    const outstanding = [...sent, ...viewed].sort((a, b) => outstandingMs(b) - outstandingMs(a));

    if (outstanding.length === 0) {
      await notifyDiscord("📋 **End-of-day contract check** — ✅ Everyone has signed. Nothing outstanding today! 🎉");
      return;
    }

    const shown = outstanding.slice(0, DIGEST_MAX_LIST);
    const lines = [];
    for (let i = 0; i < shown.length; i++) {
      const doc = shown[i];
      // Enrich with recipient name/email; fall back to the document name. Gentle
      // throttle so a long list can't trip PandaDoc's rate limit.
      let who = doc.name;
      try {
        const details = await getDocumentDetails(doc.id);
        who = recipientLabel(primaryRecipient(details)) + (doc.name ? ` — ${doc.name}` : "");
      } catch {
        /* keep doc.name */
      }
      const ago = timeAgo(doc.date_modified || doc.date_created);
      lines.push(`${i + 1}. ${who} — unsigned ${ago}`);
      await sleep(300);
    }

    const extra = outstanding.length - shown.length;
    let content =
      `📋 **End-of-day contract check** — ${outstanding.length} agent(s) still haven't signed:\n` +
      lines.join("\n");
    if (extra > 0) content += `\n…and ${extra} more.`;
    content += `\n\nPlease follow up. 🙏`;

    // Discord hard-caps messages at 2000 chars — trim safely if needed.
    if (content.length > 1990) content = content.slice(0, 1960).replace(/\n[^\n]*$/, "") + "\n…(list trimmed)";
    await notifyDiscord(content);
    console.log(`digest: posted end-of-day list (${outstanding.length} unsigned)`);
  } catch (err) {
    console.error("digest: failed to build/send", err.message ?? err);
  }
}

// Checked once a minute; fires once per day during the DIGEST_HOUR (Eastern).
async function maybeSendDigest() {
  if (!DIGEST_ENABLED) return;
  const { hour, date } = easternHourAndDate();
  if (hour === DIGEST_HOUR && lastDigestDate !== date) {
    lastDigestDate = date;
    console.log(`digest: it's ${DIGEST_HOUR}:00 ${DIGEST_TZ} — sending end-of-day contract list`);
    await sendUnsignedDigest();
  }
}

// --------------------------------------------------------------------------
// Server
// --------------------------------------------------------------------------
function startServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("pandadoc->discord worker ok");
      return;
    }

    if (req.method === "POST" && url.pathname === WEBHOOK_PATH) {
      const rawBody = await readBody(req);
      const signature = url.searchParams.get("signature");
      if (!verifyPandaDocSignature(rawBody, signature)) {
        console.error("webhook: signature verification failed — rejecting");
        res.writeHead(401);
        res.end("invalid signature");
        return;
      }
      res.writeHead(200);
      res.end("ok");
      try {
        const parsed = JSON.parse(rawBody);
        const events = Array.isArray(parsed) ? parsed : [parsed];
        await handleWebhookEvents(events);
      } catch (err) {
        console.error("webhook: failed to process", err);
      }
      return;
    }

    res.writeHead(404);
    res.end("not found");
  });

  server.listen(PORT, () => {
    console.log(`pandadoc->discord worker listening on :${PORT}  (flood-safe build)`);
    console.log(`  webhook path:   POST ${WEBHOOK_PATH}`);
    console.log(`  reminder after: ${REMINDER_HOURS}h unsigned (remind window ${Math.round(REMIND_WINDOW_MS / 60000)}m, cap ${MAX_REMINDERS_PER_CYCLE}/cycle)`);
    console.log(`  poll every:     ${POLL_INTERVAL_MINUTES}m`);
    console.log(`  daily digest:   ${DIGEST_ENABLED ? `${DIGEST_HOUR}:00 ${DIGEST_TZ}` : "off"}`);
    if (!process.env.PANDADOC_API_KEY) {
      console.warn("  PANDADOC_API_KEY not set — reminder polling & digest disabled (webhook notifications still work).");
      return;
    }
    (async () => {
      await seedBaseline();
      setInterval(checkOutstandingContracts, POLL_INTERVAL_MINUTES * 60 * 1000);
      setInterval(maybeSendDigest, 60 * 1000); // fires once/day at DIGEST_HOUR ET
    })();
  });
}

// --------------------------------------------------------------------------
// Test mode: `node index.js --test` posts two sample messages to Discord.
// --------------------------------------------------------------------------
async function runTest() {
  const now = new Date().toISOString();
  const eightHoursAgo = new Date(Date.now() - 8 * 3600 * 1000).toISOString();
  const signedSample = {
    id: "sample-signed",
    name: "Agent Lead Lab Agreement — Jane Sample",
    status: "document.completed",
    date_completed: now,
    grand_total: { amount: "1500.00", currency: "USD" },
    recipients: [{ first_name: "Jane", last_name: "Sample", email: "jane@example.com", has_completed: true }],
  };
  const unsignedSample = {
    id: "sample-unsigned",
    name: "Agent Lead Lab Agreement — John Pending",
    status: "document.viewed",
    date_modified: eightHoursAgo,
    grand_total: { amount: "2500.00", currency: "USD" },
    recipients: [{ first_name: "John", last_name: "Pending", email: "john@example.com", has_completed: false }],
  };
  console.log("Sending sample 'signed' notification…");
  await notifyDiscord(signedMessage(signedSample));
  console.log("Sending sample 'not signed yet' reminder…");
  await notifyDiscord(reminderMessage(unsignedSample));
  console.log("Done — check your Discord channel for two test messages.");
}

if (process.argv.includes("--test")) {
  runTest().then(
    () => process.exit(0),
    (err) => {
      console.error(err);
      process.exit(1);
    }
  );
} else {
  startServer();
}
