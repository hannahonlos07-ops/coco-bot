// PandaDoc -> Discord contract notifier — single self-contained file, plain
// JavaScript, zero dependencies. Node runs this directly (node index.js), so
// there's no TypeScript, no build step, and nothing for a host to misconfigure.
//
// Two jobs in one process:
//   1. Webhook server — PandaDoc calls POST /pandadoc/webhook on every document
//      state change; when a contract reaches "document.completed" (signed), it
//      posts a "✅ signed" message to Discord immediately.
//   2. Reminder poller — every PANDADOC_POLL_INTERVAL_MINUTES it asks the
//      PandaDoc API for contracts still in sent/viewed (unsigned). Any older
//      than PANDADOC_REMINDER_HOURS get a one-time "⏰ not signed yet" reminder.
//
// Start:  npm start   (or: node index.js)
// Test the Discord side without PandaDoc:  npm run test-notify

import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, existsSync } from "node:fs";

// --- tiny .env loader (only used when running locally; hosts inject env vars) -
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

// --------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? "3000");
const WEBHOOK_PATH = "/pandadoc/webhook";
const REMINDER_HOURS = Number(process.env.PANDADOC_REMINDER_HOURS ?? "8");
const POLL_INTERVAL_MINUTES = Number(process.env.PANDADOC_POLL_INTERVAL_MINUTES ?? "30");
const PANDADOC_API_BASE = "https://api.pandadoc.com/public/v1";

// Numeric status codes the PandaDoc list endpoint's `status` filter expects.
const STATUS_SENT = 1;
const STATUS_VIEWED = 5;

// Contracts we've already reminded about, so we don't nag every poll cycle.
const remindedDocIds = new Set();

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
  if (!isFinite(num)) return "";
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
// Discord delivery — webhook URL, or post as your bot (token + channel id)
// --------------------------------------------------------------------------
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
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) console.error("Discord webhook post failed", res.status, await res.text());
    return;
  }

  const token = process.env.DISCORD_BOT_TOKEN;
  const channelId = process.env.DISCORD_NOTIFY_CHANNEL_ID;
  if (!token || !channelId) {
    throw new Error(
      "No Discord destination configured — set DISCORD_WEBHOOK_URL, or DISCORD_BOT_TOKEN + DISCORD_NOTIFY_CHANNEL_ID"
    );
  }
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bot ${token}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error("Discord channel post failed", res.status, await res.text());
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
      console.log(`webhook: ${doc.id} completed — notifying Discord`);
      remindedDocIds.delete(doc.id);
      await notifyDiscord(signedMessage(doc));
    } else {
      console.log(`webhook: ${doc.id} -> ${doc.status} (${evt.event}) — no notification`);
    }
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

async function sendReminder(doc) {
  let enriched = doc;
  try {
    enriched = await getDocumentDetails(doc.id);
  } catch (err) {
    console.error(`poller: couldn't fetch details for ${doc.id}, using list row`, err);
  }
  await notifyDiscord(reminderMessage(enriched));
}

async function checkOutstandingContracts() {
  const thresholdMs = REMINDER_HOURS * 60 * 60 * 1000;
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
    let reminders = 0;
    for (const doc of outstanding) {
      if (remindedDocIds.has(doc.id)) continue;
      if (outstandingMs(doc) < thresholdMs) continue;
      await sendReminder(doc);
      remindedDocIds.add(doc.id);
      reminders++;
    }
    console.log(
      `poller: ${outstanding.length} outstanding, ${reminders} new reminder(s) sent (threshold ${REMINDER_HOURS}h)`
    );
  } catch (err) {
    console.error("poller: cycle failed", err);
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
    console.log(`pandadoc->discord worker listening on :${PORT}`);
    console.log(`  webhook path:   POST ${WEBHOOK_PATH}`);
    console.log(`  reminder after: ${REMINDER_HOURS}h unsigned`);
    console.log(`  poll every:     ${POLL_INTERVAL_MINUTES}m`);
    if (!process.env.PANDADOC_API_KEY) {
      console.warn("  PANDADOC_API_KEY not set — reminder polling disabled (webhook notifications still work).");
      return;
    }
    setTimeout(checkOutstandingContracts, 10_000);
    setInterval(checkOutstandingContracts, POLL_INTERVAL_MINUTES * 60 * 1000);
  });
}

// --------------------------------------------------------------------------
// Test mode: `node index.js --test` posts two sample messages to Discord so
// you can confirm the Discord side before wiring PandaDoc.
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
