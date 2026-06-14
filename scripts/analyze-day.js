#!/usr/bin/env node
// Diagnostic: for a given Phoenix date, dump every outbound SMS from a Setter number,
// grouped by message body prefix and userId to distinguish automated vs human sends.
// Env: GHL_TOKEN, GHL_LOCATION_ID, TARGET_DATE (YYYY-MM-DD)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

const TOKEN = process.env.GHL_TOKEN;
const LOC = process.env.GHL_LOCATION_ID;
const TARGET = process.env.TARGET_DATE;
if (!TOKEN || !LOC || !TARGET) {
  console.error("Missing env vars");
  process.exit(1);
}

const SETTER_NUMBERS = new Set(["+16029755131", "+16232350801", "+16233438753"]);
const PHX_OFFSET_MS = 7 * 60 * 60 * 1000;
const [yy, mm, dd] = TARGET.split("-").map(Number);
const startMs = Date.UTC(yy, mm - 1, dd) + PHX_OFFSET_MS;
const endMs = startMs + 24 * 60 * 60 * 1000;

const H = { Authorization: "Bearer " + TOKEN, Version: "2021-04-15", Accept: "application/json" };

async function ghl(url) {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}

async function listConvs() {
  const out = [];
  let after = null, afterDate = null;
  for (let i = 0; i < 30; i++) {
    const p = new URLSearchParams({ locationId: LOC, limit: "100", sort: "desc", sortBy: "last_message_date" });
    if (after) p.set("startAfter", after);
    if (afterDate) p.set("startAfterDate", afterDate);
    const d = await ghl("https://services.leadconnectorhq.com/conversations/search?" + p);
    const page = d.conversations || [];
    if (!page.length) break;
    let stop = false;
    for (const c of page) {
      if (c.lastMessageDate && c.lastMessageDate < startMs) { stop = true; break; }
      out.push(c);
    }
    if (stop || page.length < 100) break;
    const last = page[page.length - 1];
    after = last.id;
    afterDate = last.sort?.[0] || last.lastMessageDate;
  }
  return out;
}

async function listMsgs(cid) {
  const r = await ghl(`https://services.leadconnectorhq.com/conversations/${cid}/messages?limit=50`).catch(() => null);
  return (r && r.messages && r.messages.messages) || [];
}

(async () => {
  const convs = await listConvs();
  console.log(`Scanned ${convs.length} conversations`);

  const C = 12;
  const collected = [];
  for (let i = 0; i < convs.length; i += C) {
    const batch = convs.slice(i, i + C);
    const r = await Promise.all(batch.map(async (c) => ({ c, msgs: await listMsgs(c.id) })));
    collected.push(...r);
  }

  const matches = [];
  for (const { c, msgs } of collected) {
    for (const m of msgs) {
      const t = new Date(m.dateAdded).getTime();
      if (t < startMs || t >= endMs) continue;
      if (m.messageType !== "TYPE_SMS") continue;
      if (m.direction !== "outbound") continue;
      if (!SETTER_NUMBERS.has(m.from)) continue;
      matches.push({
        timeIso: m.dateAdded,
        contact: c.fullName || c.contactName,
        contactId: c.contactId,
        from: m.from,
        userId: m.userId || null,
        body: (m.body || "").slice(0, 160),
        status: m.status || null,
        type: m.messageType,
        meta: m.meta || null,
      });
    }
  }
  matches.sort((a, b) => new Date(a.timeIso) - new Date(b.timeIso));

  // Group by body prefix (first 60 chars)
  const groups = {};
  for (const x of matches) {
    const key = x.body.slice(0, 60);
    if (!groups[key]) groups[key] = { count: 0, userIds: new Set(), times: [], contacts: [] };
    groups[key].count++;
    groups[key].userIds.add(x.userId || "(no userId)");
    groups[key].times.push(x.timeIso);
    if (groups[key].contacts.length < 5) groups[key].contacts.push(x.contact);
  }
  const groupSummary = Object.entries(groups)
    .sort((a, b) => b[1].count - a[1].count)
    .map(([body, g]) => ({
      count: g.count,
      bodyHead: body,
      userIds: [...g.userIds],
      firstAt: g.times[0],
      lastAt: g.times[g.times.length - 1],
      sampleContacts: g.contacts,
    }));

  const userSummary = {};
  for (const x of matches) {
    const u = x.userId || "(no userId)";
    userSummary[u] = (userSummary[u] || 0) + 1;
  }

  const out = {
    targetDate: TARGET,
    totalOutboundSmsFromSetters: matches.length,
    countByUserId: userSummary,
    bodyGroups: groupSummary,
    rawSample: matches.slice(0, 20),
  };
  fs.writeFileSync(path.join(REPO_ROOT, `analyze-${TARGET}.json`), JSON.stringify(out, null, 2));
  console.log("done", matches.length);
})().catch((e) => { console.error(e); process.exit(1); });
