#!/usr/bin/env node
// Turns WhatsApp voice notes into text on the Mac (Owen 16 Nov: last 12 months, then new ones going forward).
// node transcribe.mjs --days 365   (newest first, skips ones already done; safe to stop and rerun)
import { waDb, transcribe } from './wa.js';
const days = Number((process.argv.indexOf('--days') > -1 && process.argv[process.argv.indexOf('--days') + 1]) || 3);
const db = await waDb();
if (!db) process.exit(0);
const since = Date.now() / 1000 - 978307200 - days * 86400;
const rows = db.prepare(`SELECT m.Z_PK pk, m.ZMESSAGETYPE type, mi.ZMEDIALOCALPATH media FROM ZWAMESSAGE m JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM
  WHERE m.ZMESSAGETYPE = 3 AND mi.ZMEDIALOCALPATH IS NOT NULL AND m.ZMESSAGEDATE > ? ORDER BY m.ZMESSAGEDATE DESC`).all(since).map((r) => ({ ...r }));
let done = 0;
for (let i = 0; i < rows.length; i += 25) {
  done += await transcribe(rows.slice(i, i + 25), 25);
  if (i % 250 === 0) console.log(new Date().toISOString(), `checked ${Math.min(i + 25, rows.length)}/${rows.length}, transcribed ${done}`);
}
console.log(new Date().toISOString(), `finished: ${rows.length} voice notes in last ${days} days, ${done} newly transcribed`);
