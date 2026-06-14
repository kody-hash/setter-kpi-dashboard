#!/usr/bin/env node
// Setter KPI refresh script — pulls GHL data, writes data.json.
// Run by GitHub Action on a schedule. Requires GHL_TOKEN and GHL_LOCATION_ID env vars.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const TOKEN = process.env.GHL_TOKEN;
const LOCATION_ID = process.env.GHL_LOCATION_ID;
if (!TOKEN || !LOCATION_ID) {
  console.error("FATAL: GHL_TOKEN or GHL_LOCATION_ID env var missing");
  process.exit(1);
}

const ANSWERED_MIN_DURATION_SEC = 30;

const SETTER_NUMBERS = new Set([
  "+16029755131", // Lead Setter 1
  "+16232350801", // Lead Setter 2
  "+16233438753", // Lead Setter 3
]);

function isSetterSide(m) {
  if (m.direction === "outbound") return SETTER_NUMBERS.has(m.from);
  if (m.direction === "inbound") return SETTER_NUMBERS.has(m.to);
  return false;
}
const BASE = "https://services.leadconnectorhq.com";
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Version: "2021-07-28",
  Accept: "application/json",
};

function ranges() {
  // Phoenix is UTC-7 year-round (no DST)
  const PHX_OFFSET_MS = 7 * 60 * 60 * 1000;
  const now = new Date();
  const nowPhx = new Date(now.getTime() - PHX_OFFSET_MS);
  const startOfTodayPhx = new Date(Date.UTC(nowPhx.getUTCFullYear(), nowPhx.getUTCMonth(), nowPhx.getUTCDate()));
  const startOfMonthPhx = new Date(Date.UTC(nowPhx.getUTCFullYear(), nowPhx.getUTCMonth(), 1));
  return {
    nowMs: now.getTime(),
    todayMs: startOfTodayPhx.getTime() + PHX_OFFSET_MS,
    monthMs: startOfMonthPhx.getTime() + PHX_OFFSET_MS,
    nowIso: now.toISOString(),
    todayIso: new Date(startOfTodayPhx.getTime() + PHX_OFFSET_MS).toISOString(),
    monthIso: new Date(startOfMonthPhx.getTime() + PHX_OFFSET_MS).toISOString(),
  };
}

function localDayKey(ms) {
  const PHX_OFFSET_MS = 7 * 60 * 60 * 1000;
  const d = new Date(ms - PHX_OFFSET_MS);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function ghlFetch(method, urlPath, body) {
  const opts = { method, headers: { ...HEADERS } };
  if (body) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + urlPath, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  try { return JSON.parse(text); } catch { return text; }
}

async function searchContactsCount(rangeStartMs, rangeEndMs) {
  const body = {
    locationId: LOCATION_ID,
    pageLimit: 100,
    filters: [{ field: "dateAdded", operator: "range", value: { gte: rangeStartMs, lte: rangeEndMs } }],
  };
  const out = await ghlFetch("POST", "/contacts/search", body);
  return typeof out.total === "number" ? out.total : (out.contacts || []).length;
}

async function listConversationsSince(rangeStartMs) {
  const out = [];
  let startAfter = null;
  let startAfterDate = null;
  for (let i = 0; i < 30; i++) {
    const params = new URLSearchParams({
      locationId: LOCATION_ID,
      limit: "100",
      sort: "desc",
      sortBy: "last_message_date",
    });
    if (startAfter) params.set("startAfter", startAfter);
    if (startAfterDate) params.set("startAfterDate", startAfterDate);
    const data = await ghlFetch("GET", `/conversations/search?${params.toString()}`);
    const page = data.conversations || [];
    if (page.length === 0) break;
    let stop = false;
    for (const c of page) {
      if (c.lastMessageDate && c.lastMessageDate < rangeStartMs) { stop = true; break; }
      out.push(c);
    }
    if (stop || page.length < 100) break;
    const last = page[page.length - 1];
    startAfter = last.id;
    startAfterDate = last.sort?.[0] || last.lastMessageDate;
  }
  return out;
}

async function listMessagesSince(conversationId, sinceMs) {
  const out = [];
  let lastMessageId = null;
  for (let i = 0; i < 10; i++) {
    const params = new URLSearchParams({ limit: "100" });
    if (lastMessageId) params.set("lastMessageId", lastMessageId);
    const data = await ghlFetch("GET", `/conversations/${conversationId}/messages?${params.toString()}`);
    const m = data.messages || {};
    const page = m.messages || [];
    if (page.length === 0) break;
    let stop = false;
    for (const msg of page) {
      const t = new Date(msg.dateAdded).getTime();
      if (t < sinceMs) { stop = true; break; }
      out.push(msg);
    }
    if (stop || !m.nextPage) break;
    lastMessageId = m.lastMessageId;
  }
  return out;
}

function classifyMessage(m) {
  const mt = m.messageType || "";
  if (mt === "TYPE_SMS") return "sms";
  if (mt === "TYPE_CALL" || mt === "TYPE_PHONE_CALL") return "call";
  if (mt === "TYPE_VOICEMAIL") return "voicemail";
  if (mt === "TYPE_EMAIL") return "email";
  return "other";
}

async function build() {
  const r = ranges();
  const [contactsToday, contactsMtd] = await Promise.all([
    searchContactsCount(r.todayMs, r.nowMs),
    searchContactsCount(r.monthMs, r.nowMs),
  ]);
  const conversations = await listConversationsSince(r.monthMs);
  console.log(`scanning ${conversations.length} conversations`);

  const today = { contacts: contactsToday, uniqueCallsAttempted: 0, uniqueTextsSent: 0, uniqueCallsAnswered: 0, uniqueTextsResponded: 0 };
  const mtd = { contacts: contactsMtd, uniqueCallsAttempted: 0, uniqueTextsSent: 0, uniqueCallsAnswered: 0, uniqueTextsResponded: 0 };
  const todayUniqueCalledIds = new Set();
  const todayUniqueTextedIds = new Set();
  const todayUniqueCallsAnsweredIds = new Set();
  const todayInboundTextIds = new Set();
  const mtdUniqueCalledIds = new Set();
  const mtdUniqueTextedIds = new Set();
  const mtdUniqueCallsAnsweredIds = new Set();
  const mtdInboundTextIds = new Set();
  const dailyByDate = {};
  const todayContactDetails = new Map();

  function bumpDetail(cid, name, field, ts) {
    let d = todayContactDetails.get(cid);
    if (!d) {
      d = { name: name || "(unnamed)", contactId: cid, calls: 0, texts: 0, answered: false, responded: false, firstAt: ts, lastAt: ts };
      todayContactDetails.set(cid, d);
    }
    if (field === "calls") d.calls++;
    if (field === "texts") d.texts++;
    if (field === "answered") d.answered = true;
    if (field === "responded") d.responded = true;
    if (ts < d.firstAt) d.firstAt = ts;
    if (ts > d.lastAt) d.lastAt = ts;
  }

  const conversationsToScan = conversations.slice(0, 800);
  const CONCURRENCY = 12;
  const allFetched = [];
  for (let i = 0; i < conversationsToScan.length; i += CONCURRENCY) {
    const batch = conversationsToScan.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((c) =>
        listMessagesSince(c.id, r.monthMs).then((msgs) => ({ c, msgs })).catch(() => ({ c, msgs: [] }))
      )
    );
    allFetched.push(...results);
  }

  for (const { c, msgs } of allFetched) {
    for (const m of msgs) {
      const t = new Date(m.dateAdded).getTime();
      const inToday = t >= r.todayMs;
      const kind = classifyMessage(m);
      const direction = m.direction;
      if ((kind === "sms" || kind === "call") && !isSetterSide(m)) continue;
      const cid = c.contactId;
      if (!cid) continue;
      const cname = c.fullName || c.contactName || "(unnamed)";
      const dayKey = localDayKey(t);
      if (!dailyByDate[dayKey]) {
        dailyByDate[dayKey] = { called: new Set(), texted: new Set(), callsAnswered: new Set(), textedIn: new Set() };
      }

      if (direction === "outbound") {
        if (kind === "sms") {
          mtdUniqueTextedIds.add(cid);
          dailyByDate[dayKey].texted.add(cid);
          if (inToday) {
            todayUniqueTextedIds.add(cid);
            bumpDetail(cid, cname, "texts", t);
          }
        } else if (kind === "call") {
          mtdUniqueCalledIds.add(cid);
          dailyByDate[dayKey].called.add(cid);
          if (inToday) {
            todayUniqueCalledIds.add(cid);
            bumpDetail(cid, cname, "calls", t);
          }
          const status = (m.status || m.meta?.call?.status || "").toLowerCase();
          const dur = m.meta?.callDuration ?? m.meta?.call?.duration ?? m.callDuration ?? m.duration ?? 0;
          if (status === "completed" && typeof dur === "number" && dur >= ANSWERED_MIN_DURATION_SEC) {
            mtdUniqueCallsAnsweredIds.add(cid);
            dailyByDate[dayKey].callsAnswered.add(cid);
            if (inToday) {
              todayUniqueCallsAnsweredIds.add(cid);
              bumpDetail(cid, cname, "answered", t);
            }
          }
        }
      } else if (direction === "inbound" && kind === "sms") {
        mtdInboundTextIds.add(cid);
        dailyByDate[dayKey].textedIn.add(cid);
        if (inToday) todayInboundTextIds.add(cid);
      }
    }
  }

  for (const cid of todayUniqueTextedIds) {
    if (todayInboundTextIds.has(cid)) {
      const d = todayContactDetails.get(cid);
      if (d) d.responded = true;
    }
  }

  today.uniqueCallsAttempted = todayUniqueCalledIds.size;
  today.uniqueTextsSent = todayUniqueTextedIds.size;
  today.uniqueCallsAnswered = todayUniqueCallsAnsweredIds.size;
  today.uniqueTextsResponded = [...todayUniqueTextedIds].filter((id) => todayInboundTextIds.has(id)).length;

  const sortByLastDesc = (a, b) => b.lastAt - a.lastAt;
  today.calledContacts = [...todayContactDetails.values()]
    .filter((d) => d.calls > 0)
    .sort(sortByLastDesc)
    .map((d) => ({ name: d.name, calls: d.calls, answered: d.answered, lastAt: new Date(d.lastAt).toISOString() }));
  today.textedContacts = [...todayContactDetails.values()]
    .filter((d) => d.texts > 0)
    .sort(sortByLastDesc)
    .map((d) => ({ name: d.name, texts: d.texts, responded: d.responded, lastAt: new Date(d.lastAt).toISOString() }));

  const daily = Object.keys(dailyByDate)
    .sort()
    .map((date) => {
      const d = dailyByDate[date];
      const responded = [...d.texted].filter((id) => d.textedIn.has(id)).length;
      return {
        date,
        uniqueCallsAttempted: d.called.size,
        uniqueTextsSent: d.texted.size,
        uniqueCallsAnswered: d.callsAnswered.size,
        uniqueTextsResponded: responded,
      };
    });

  mtd.uniqueCallsAttempted = daily.reduce((s, d) => s + d.uniqueCallsAttempted, 0);
  mtd.uniqueTextsSent = daily.reduce((s, d) => s + d.uniqueTextsSent, 0);
  mtd.uniqueCallsAnswered = daily.reduce((s, d) => s + d.uniqueCallsAnswered, 0);
  mtd.uniqueTextsResponded = daily.reduce((s, d) => s + d.uniqueTextsResponded, 0);

  return {
    generatedAt: new Date().toISOString(),
    ranges: { todayIso: r.todayIso, monthIso: r.monthIso, nowIso: r.nowIso },
    today,
    mtd,
    daily,
    conversationsScanned: conversationsToScan.length,
  };
}

build()
  .then((data) => {
    const outPath = path.join(REPO_ROOT, "data.json");
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`wrote ${outPath} (${JSON.stringify(data).length} bytes)`);
    console.log(`today: ${data.today.uniqueCallsAttempted} called, ${data.today.uniqueTextsSent} texted`);
  })
  .catch((e) => {
    console.error("BUILD FAILED:", e.message, e.stack);
    process.exit(1);
  });
