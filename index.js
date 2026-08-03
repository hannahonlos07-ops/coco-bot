// Discord out-of-office auto-reply bot. Watches a designated support channel
// in every server it's in, and — outside your business hours — replies once to
// each person with your out-of-office message. Same message + schedule for all
// servers, all configured via environment variables (no code edits needed).
//
// Start:  npm start   (or: node index.js)

import { Client, Events, GatewayIntentBits } from "discord.js";
import http from "node:http";
import { readFileSync, existsSync } from "node:fs";

// --------------------------------------------------------------------------
// Config (all from environment variables)
// --------------------------------------------------------------------------
const TOKEN = process.env.DISCORD_BOT_TOKEN;
if (!TOKEN) {
  console.error("Missing DISCORD_BOT_TOKEN");
  process.exit(1);
}

const MESSAGE =
  process.env.OOO_MESSAGE ??
  "Thanks for reaching out! Our team is currently out of office. We'll get back to you as soon as we're back during business hours.";

const TIMEZONE = process.env.OOO_TIMEZONE ?? "America/New_York";
const START_HOUR = Number(process.env.OOO_START_HOUR ?? "9");
const END_HOUR = Number(process.env.OOO_END_HOUR ?? "18");
const COOLDOWN_MS = Number(process.env.OOO_COOLDOWN_MINUTES ?? "240") * 60 * 1000;

// What counts as "someone asking us", i.e. when to auto-reply:
//   mention  – only when your bot is @mentioned (least spammy)
//   channels – any message in a support-type channel (see OOO_SUPPORT_CHANNELS)
//   all      – any message in any channel (most aggressive; dedupe still applies)
//   both     – mention OR support channel (default, sensible middle ground)
const TRIGGER = (process.env.OOO_TRIGGER ?? "both").toLowerCase();

// FAQ: when enabled, Coco reads the message text and — if it matches a known
// topic in faq.json — replies with that answer (works 24/7). Requires the
// "Message Content" privileged intent to be enabled in the Developer Portal,
// which is why it's off unless FAQ_ENABLED=true (so it never disturbs the base
// out-of-office bot until you opt in).
const FAQ_ENABLED = (process.env.FAQ_ENABLED ?? "false").toLowerCase() === "true";
const FAQ = FAQ_ENABLED ? loadFaq() : [];
const FAQ_COOLDOWN_MS = 60 * 1000; // don't answer the same person the same topic more than once a minute

function loadFaq() {
  try {
    if (!existsSync("faq.json")) {
      console.warn("FAQ_ENABLED=true but faq.json not found — FAQ answers disabled until you add it.");
      return [];
    }
    const data = JSON.parse(readFileSync("faq.json", "utf8"));
    if (!Array.isArray(data)) return [];
    // Keep only well-formed entries: { keywords: [...], answer: "..." }
    return data.filter((e) => e && Array.isArray(e.keywords) && typeof e.answer === "string");
  } catch (err) {
    console.error("Couldn't read faq.json (check for a JSON typo like a missing comma):", err?.message ?? err);
    return [];
  }
}

// Returns { entry, index } of the first FAQ topic whose keyword appears in the
// message, or null. Case-insensitive substring match.
function matchFaq(text) {
  const t = (text || "").toLowerCase();
  if (!t) return null;
  for (let i = 0; i < FAQ.length; i++) {
    for (const kw of FAQ[i].keywords) {
      const k = String(kw).toLowerCase().trim();
      if (k && t.includes(k)) return { entry: FAQ[i], index: i };
    }
  }
  return null;
}

// --------------------------------------------------------------------------
// Contracts command: on request, Coco pulls the LIVE list of unsigned PandaDoc
// contracts. INTERNAL ONLY — locked to your team server(s) by ID so clients in
// other servers can never pull it. Enabled only when both PANDADOC_API_KEY and
// PANDADOC_LIST_GUILD_IDS are set.
const PANDADOC_API_KEY = process.env.PANDADOC_API_KEY ?? "";
const PANDADOC_API_BASE = "https://api.pandadoc.com/public/v1";
const PANDADOC_STATUS_SENT = 1;
const PANDADOC_STATUS_VIEWED = 5;
const CONTRACT_LIST_GUILD_IDS = (process.env.PANDADOC_LIST_GUILD_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CONTRACTS_ENABLED = !!PANDADOC_API_KEY && CONTRACT_LIST_GUILD_IDS.length > 0;
const CONTRACT_LIST_MAX = 40;
let lastContractFetch = 0; // simple throttle so the command can't hammer PandaDoc

// Phrases that mean "show me the unsigned contracts". Needs both a "contract/
// sign" word and a "list/unsigned/pending" sense, to avoid false triggers.
function isUnsignedListRequest(text) {
  const t = (text || "").toLowerCase();
  if (!t) return false;
  const aboutContracts = /(contract|signed|signature|sign)/.test(t);
  const wantsList = /(unsigned|not signed|haven't signed|havent signed|hasn't signed|hasnt signed|didn't sign|didnt sign|pending|outstanding|list|who has not|who hasn|not yet sign|still need|need to sign|awaiting)/.test(t);
  return aboutContracts && wantsList;
}

async function pandaGet(path) {
  const res = await fetch(`${PANDADOC_API_BASE}${path}`, { headers: { Authorization: `API-Key ${PANDADOC_API_KEY}` } });
  if (!res.ok) throw new Error(`PandaDoc GET ${path} -> ${res.status}`);
  return res.json();
}
async function listPandaByStatus(code) {
  const data = await pandaGet(`/documents?status=${code}&count=100&order_by=date_created`);
  return data.results ?? [];
}
function docAgeMs(doc) {
  const iso = doc.date_modified || doc.date_created;
  const t = iso ? Date.parse(iso) : NaN;
  return isFinite(t) ? Date.now() - t : 0;
}
function contractClientName(name) {
  if (!name) return "(unknown)";
  const i = name.toLowerCase().lastIndexOf(" x ");
  return (i !== -1 ? name.slice(i + 3) : name).trim();
}
function contractCompactAge(iso) {
  const t = iso ? new Date(iso).getTime() : NaN;
  if (isNaN(t)) return "";
  const h = (Date.now() - t) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m`;
  if (h < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

// Fetches unsigned contracts and returns an array of Discord-sized messages
// (newest first, sleek, name-first). Empty array on error is handled by caller.
async function buildUnsignedContractMessages() {
  const [sent, viewed] = await Promise.all([
    listPandaByStatus(PANDADOC_STATUS_SENT),
    listPandaByStatus(PANDADOC_STATUS_VIEWED),
  ]);
  const outstanding = [...sent, ...viewed].sort((a, b) => docAgeMs(a) - docAgeMs(b)); // newest first
  if (outstanding.length === 0) return ["📋 **Unsigned contracts** — ✅ None right now. All signed! 🎉"];

  const capped = outstanding.slice(0, CONTRACT_LIST_MAX);
  const extra = outstanding.length - capped.length;
  const lines = capped.map((d, i) => `${i + 1}. **${contractClientName(d.name)}** · ${contractCompactAge(d.date_modified || d.date_created)}`);
  const header = `📋 **Unsigned contracts** · ${outstanding.length} pending`;
  const footer = extra > 0 ? `_+${extra} more (${CONTRACT_LIST_MAX} shown)_` : "";

  const messages = [];
  let cur = header;
  for (const line of lines) {
    if ((cur + "\n" + line).length > 1900) { messages.push(cur); cur = line; }
    else cur += "\n" + line;
  }
  if (footer) {
    if ((cur + "\n\n" + footer).length <= 1990) cur += "\n\n" + footer;
    else { messages.push(cur); cur = footer; }
  }
  messages.push(cur);
  return messages;
}

// Channel matching: by name (case-insensitive, e.g. "support") and/or by
// exact channel ID for precision.
const CHANNEL_NAMES = (process.env.OOO_SUPPORT_CHANNELS ?? "support")
  .toLowerCase()
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const CHANNEL_IDS = (process.env.OOO_SUPPORT_CHANNEL_IDS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// 1 = Monday ... 7 = Sunday (ISO). Default Mon–Fri.
const WEEKDAY_INDEX = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
const BUSINESS_DAYS = parseDays(process.env.OOO_BUSINESS_DAYS ?? "1-5");

function parseDays(spec) {
  const days = new Set();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (part.includes("-")) {
      const [a, b] = part.split("-").map(Number);
      for (let d = a; d <= b; d++) days.add(d);
    } else {
      days.add(Number(part));
    }
  }
  return days;
}

// --------------------------------------------------------------------------
// Schedule logic (pure, timezone-aware via Intl — no libraries)
// --------------------------------------------------------------------------
function nowPartsInTz(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(date);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  return {
    weekday: WEEKDAY_INDEX[get("weekday")],
    hour: Number(get("hour")),
    minute: Number(get("minute")),
  };
}

// Out of office = NOT (an allowed business day AND within business hours).
export function isOutOfOffice(date = new Date()) {
  const { weekday, hour, minute } = nowPartsInTz(date, TIMEZONE);
  const onBusinessDay = BUSINESS_DAYS.has(weekday);
  const minutesNow = hour * 60 + minute;
  const withinHours = minutesNow >= START_HOUR * 60 && minutesNow < END_HOUR * 60;
  return !(onBusinessDay && withinHours);
}

// --------------------------------------------------------------------------
// Discord bot
// --------------------------------------------------------------------------
function isSupportChannel(channel) {
  if (!channel) return false;
  if (CHANNEL_IDS.includes(channel.id)) return true;
  const name = (channel.name ?? "").toLowerCase();
  return CHANNEL_NAMES.some((n) => name === n || name.includes(n));
}

// Anti-spam state:
//   repliedThisPeriod — each person we've already answered during the CURRENT
//     out-of-office stretch. Cleared when business hours resume, so a person
//     gets at most one auto-reply per OOO period.
//   lastReplyAt — a rolling cooldown floor as a secondary guard.
const repliedThisPeriod = new Set(); // key: `${guildId}:${userId}`
const lastReplyAt = new Map(); // key: `${guildId}:${userId}` -> timestamp
const faqLastReplyAt = new Map(); // key: `${userId}:${faqIndex}` -> timestamp

// Message Content is a privileged intent, only needed (and only requested) when
// FAQ is on — so the base bot keeps working without it.
const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
if (FAQ_ENABLED || CONTRACTS_ENABLED) intents.push(GatewayIntentBits.MessageContent);

const client = new Client({ intents });

// Keep the bot alive through transient gateway/network errors (discord.js
// reconnects on its own); just log them instead of crashing the process.
client.on(Events.Error, (err) => console.error("client error:", err?.message ?? err));
process.on("unhandledRejection", (err) => console.error("unhandledRejection:", err?.message ?? err));

// Watch for the transition back INTO business hours and reset the per-period
// dedupe, so the next out-of-office stretch starts fresh (everyone can get one
// reply again). Checked once a minute.
let wasOutOfOffice = isOutOfOffice();
setInterval(() => {
  const out = isOutOfOffice();
  if (wasOutOfOffice && !out) {
    repliedThisPeriod.clear();
    console.log("business hours resumed — auto-reply dedupe reset");
  }
  wasOutOfOffice = out;
}, 60 * 1000);

function shouldAutoReply(message) {
  const mentioned =
    !!client.user &&
    message.mentions?.users?.has(client.user.id) &&
    !message.mentions?.everyone; // a direct @bot, not @everyone/@here
  const inSupport = isSupportChannel(message.channel);
  if (TRIGGER === "mention") return mentioned;
  if (TRIGGER === "channels") return inSupport;
  if (TRIGGER === "all") return true;
  return mentioned || inSupport; // "both"
}

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author?.bot) return; // ignore bots (including ourselves)
    if (!message.guild) return; // ignore DMs
    if (!shouldAutoReply(message)) return; // not a trigger for the chosen mode

    // 0) Live "unsigned contracts" command — INTERNAL team server(s) only.
    if (CONTRACTS_ENABLED && CONTRACT_LIST_GUILD_IDS.includes(message.guildId) && isUnsignedListRequest(message.content)) {
      if (Date.now() - lastContractFetch < 10_000) return; // throttle rapid repeats
      lastContractFetch = Date.now();
      try {
        const msgs = await buildUnsignedContractMessages();
        await message.reply({ content: msgs[0], allowedMentions: { repliedUser: true } });
        for (let i = 1; i < msgs.length; i++) {
          await message.channel.send({ content: msgs[i], allowedMentions: { parse: [] } });
        }
        console.log(`contracts: sent unsigned list to ${message.author.tag} in "${message.guild.name}"`);
      } catch (err) {
        console.error("contracts: fetch failed", err?.message ?? err);
        await message.reply("Sorry, I couldn't reach PandaDoc just now — try again in a moment.");
      }
      return;
    }

    // 1) FAQ — answers known questions any time of day.
    if (FAQ.length) {
      const hit = matchFaq(message.content);
      if (hit) {
        const fkey = `${message.author.id}:${hit.index}`;
        if (Date.now() - (faqLastReplyAt.get(fkey) ?? 0) >= FAQ_COOLDOWN_MS) {
          faqLastReplyAt.set(fkey, Date.now());
          await message.reply({ content: hit.entry.answer, allowedMentions: { repliedUser: true } });
          console.log(`FAQ reply (topic #${hit.index}) -> ${message.author.tag} in "${message.guild.name}"`);
        }
        return; // handled as an FAQ; don't also send the out-of-office message
      }
    }

    // 2) Out-of-office fallback — only outside business hours.
    if (!isOutOfOffice()) return; // within business hours — stay silent

    const key = `${message.guildId}:${message.author.id}`;
    if (repliedThisPeriod.has(key)) return; // already answered this person this OOO period
    if (Date.now() - (lastReplyAt.get(key) ?? 0) < COOLDOWN_MS) return; // cooldown floor
    repliedThisPeriod.add(key);
    lastReplyAt.set(key, Date.now());

    await message.reply({ content: MESSAGE, allowedMentions: { repliedUser: true } });
    console.log(`OOO reply -> #${message.channel?.name} in "${message.guild.name}" (to ${message.author.tag})`);
  } catch (err) {
    console.error("OOO reply failed:", err?.message ?? err);
  }
});

client.once(Events.ClientReady, (c) => {
  console.log(`OOO bot online as ${c.user.tag}`);
  console.log(`  trigger mode:  ${TRIGGER} (mention | channels | all | both)`);
  console.log(`  FAQ:           ${FAQ_ENABLED ? `on, ${FAQ.length} topic(s) loaded` : "off (set FAQ_ENABLED=true)"}`);
  console.log(`  contracts cmd: ${CONTRACTS_ENABLED ? `on (team server[s]: ${CONTRACT_LIST_GUILD_IDS.join(", ")})` : "off (set PANDADOC_API_KEY + PANDADOC_LIST_GUILD_IDS)"}`);
  console.log(`  timezone:      ${TIMEZONE}`);
  console.log(`  business hours: ${START_HOUR}:00–${END_HOUR}:00, days ${[...BUSINESS_DAYS].join(",")} (1=Mon…7=Sun)`);
  console.log(`  support match:  names=[${CHANNEL_NAMES.join(", ")}] ids=[${CHANNEL_IDS.join(", ") || "none"}]`);
  console.log(`  in ${c.guilds.cache.size} server(s); currently ${isOutOfOffice() ? "OUT of office → will auto-reply" : "within business hours → silent"}`);
});

client.login(TOKEN);

// Minimal health endpoint so hosts (Railway) see a healthy service.
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("discord out-of-office bot ok");
  })
  .listen(Number(process.env.PORT ?? "3000"));
