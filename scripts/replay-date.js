#!/usr/bin/env node
// One-off replay: scan GHL for a specific Phoenix calendar day and write replay-YYYY-MM-DD.json.
// Env: GHL_TOKEN, GHL_LOCATION_ID, TARGET_DATE (YYYY-MM-DD, Phoenix).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const TOKEN = process.env.GHL_TOKEN;
const LOCATION_ID = process.env.GHL_LOCATION_ID;
const TARGET_DATE = process.env.TARGET_DATE;
if (!TOKEN || !LOCATION_ID || !TARGET_DATE) {
  console.error("FATAL: GHL_TOKEN, GHL_LOCATION_ID, TARGET_DATE env vars required");
  process.exit(1);
}
if (!/^\d{4}-\d{2}-\d{2}$/.test(TARGET_DATE)) {
  console.error("FATAL: TARGET_DATE must be YYYY-MM-DD");
  process.exit(1);
}

const ANSWERED_MIN_DURATION_SEC = 30;
const PHX_OFFSET_MS = 7 * 60 * 60 * 1000;
const BASE = "https://services.leadconnectorhq.com";
const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  Version: "2021-07-28",
  Accept: "application/json",
};

// TARGET_DATE 00:00 Phoenix -> UTC ISO
const [yy, mm, dd] = TARGET_DATE.split("-").map(Number);
const targetStartMs = Date.UTC(yy, mm - 1, dd) + PHX_OFFSET_MS;
const targetEndMs = targetStartMs + 24 * 60 * 60 * 1000;

console.log(`Replay target: ${TARGET_DATE} (Phoenix)`);
console.log(`  range: ${new Date(targetStartMs).toISOString()} -> ${new Date(targetEndMs).toISOString()}`);

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

async function listConversationsSince(rangeStartMs) {
  const out = [];
  let startAfter = null;
  let startAfterDate = null;
  for (let i = 0; i < 20; i++) {
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
  for (let i = 0; i < 20; i++) {
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
  // Scan conversations active since the target day started (and after — they may have activity on target day too)
  const conversations = await listConversationsSince(targetStartMs);
  console.log(`scanning ${conversations.length} conversations`);

  const targetUniqueCalledIds = new Set();
  const targetUniqueTextedIds = new Set();
  const targetUniqueCallsAnsweredIds = new Set();
  const targetInboundTextIds = new Set();
  const contactDetails = new Map();

  function bumpDetail(cid, name, field, ts) {
    let d = contactDetails.get(cid);
    if (!d) {
      d = { name: name || "(unnamed)", contactId: cid, calls: 0, texts: 0, answered: false, responded: false, firstAt: ts, lastAt: ts };
      contactDetails.set(cid, d);
    }
    if (field === "calls") d.calls++;
    if (field === "texts") d.texts++;
    if (field === "answered") d.answered = true;
    if (field === "responded") d.responded = true;
    if (ts < d.firstAt) d.firstAt = ts;
    if (ts > d.lastAt) d.lastAt = ts;
  }

  const conversationsToScan = conversations.slice(0, 400);
  const CONCURRENCY = 12;
  const allFetched = [];
  for (let i = 0; i < conversationsToScan.length; i += CONCURRENCY) {
    const batch = conversationsToScan.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map((c) =>
        listMessagesSince(c.id, targetStartMs).then((msgs) => ({ c, msgs })).catch(() => ({ c, msgs: [] }))
      )
    );
    allFetched.push(...results);
  }

  for (const { c, msgs } of allFetched) {
    for (const m of msgs) {
      const t = new Date(m.dateAdded).getTime();
      const inTarget = t >= targetStartMs && t < targetEndMs;
      if (!inTarget) continue;
      const kind = classifyMessage(m);
      const direction = m.direction;
      const cid = c.contactId;
      if (!cid) continue;
      const cname = c.fullName || c.contactName || "(unnamed)";

      if (direction === "outbound") {
        if (kind === "sms") {
          targetUniqueTextedIds.add(cid);
          bumpDetail(cid, cname, "texts", t);
        } else if (kind === "call") {
          targetUniqueCalledIds.add(cid);
          bumpDetail(cid, cname, "calls", t);
          const status = (m.status || m.meta?.call?.status || "").toLowerCase();
          const dur = m.meta?.callDuration ?? m.meta?.call?.duration ?? m.callDuration ?? m.duration ?? 0;
          if (status === "completed" && typeof dur === "number" && dur >= ANSWERED_MIN_DURATION_SEC) {
            targetUniqueCallsAnsweredIds.add(cid);
            bumpDetail(cid, cname, "answered", t);
          }
        }
      } else if (direction === "inbound" && kind === "sms") {
        targetInboundTextIds.add(cid);
      }
    }
  }

  for (const cid of targetUniqueTextedIds) {
    if (targetInboundTextIds.has(cid)) {
      const d = contactDetails.get(cid);
      if (d) d.responded = true;
    }
  }

  const sortByLastAsc = (a, b) => a.lastAt - b.lastAt;

  const calledContacts = [...contactDetails.values()]
    .filter((d) => d.calls > 0)
    .sort(sortByLastAsc)
    .map((d) => ({ name: d.name, calls: d.calls, answered: d.answered, lastAt: new Date(d.lastAt).toISOString() }));
  const textedContacts = [...contactDetails.values()]
    .filter((d) => d.texts > 0)
    .sort(sortByLastAsc)
    .map((d) => ({ name: d.name, texts: d.texts, responded: d.responded, lastAt: new Date(d.lastAt).toISOString() }));

  return {
    generatedAt: new Date().toISOString(),
    targetDate: TARGET_DATE,
    range: { startIso: new Date(targetStartMs).toISOString(), endIso: new Date(targetEndMs).toISOString() },
    summary: {
      uniqueCallsAttempted: targetUniqueCalledIds.size,
      uniqueCallsAnswered: targetUniqueCallsAnsweredIds.size,
      uniqueTextsSent: targetUniqueTextedIds.size,
      uniqueTextsResponded: [...targetUniqueTextedIds].filter((id) => targetInboundTextIds.has(id)).length,
    },
    calledContacts,
    textedContacts,
    conversationsScanned: conversationsToScan.length,
  };
}

build()
  .then((data) => {
    const outPath = path.join(REPO_ROOT, `replay-${TARGET_DATE}.json`);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
    console.log(`wrote ${outPath} (${JSON.stringify(data).length} bytes)`);
    console.log(`${TARGET_DATE}: ${data.summary.uniqueCallsAttempted} called (${data.summary.uniqueCallsAnswered} ans), ${data.summary.uniqueTextsSent} texted (${data.summary.uniqueTextsResponded} resp)`);
  })
  .catch((e) => {
    console.error("REPLAY FAILED:", e.message, e.stack);
    process.exit(1);
  });
