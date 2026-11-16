/**
 * WhatsApp history straight from the WhatsApp Mac app's own database (read only, never written).
 * Holds everything the Mac app has: back to 2015, all chats. Live as the app syncs.
 * Nothing leaves the Mac: Claude reads it locally through the MCP.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { execFile } from 'child_process';
import { promisify } from 'util';
const run = promisify(execFile);
const TDIR = path.join(os.homedir(), '.moon-snippets/wa-transcripts'); // voice note text, one file per message, private
const MODEL = path.join(os.homedir(), '.cache/whisper-models/ggml-small.bin');
const BIN = (n) => ['/opt/homebrew/bin/' + n, '/usr/local/bin/' + n].find((p) => fs.existsSync(p));
const FILE = path.join(os.homedir(), 'Library/Group Containers/group.net.whatsapp.WhatsApp.shared/ChatStorage.sqlite');
const EPOCH = 978307200; // Apple Core Data dates count from 2001-01-01
let db = null;

export async function waDb() {
  if (db) return db;
  if (!fs.existsSync(FILE)) return null;
  const { DatabaseSync } = await import('node:sqlite');
  db = new DatabaseSync(FILE, { readOnly: true });
  return db;
}

const iso = (d) => (d == null ? null : new Date((Number(d) + EPOCH) * 1000).toISOString());
const toCd = (s) => { const t = Date.parse(s); if (isNaN(t)) throw new Error(`Bad date "${s}", use YYYY-MM-DD`); return t / 1000 - EPOCH; };
const daysAgoCd = (n) => Date.now() / 1000 - EPOCH - n * 86400;
const lim = (n, d, max) => Math.max(1, Math.min(max, Number(n) || d));
const plain = (r) => Object.assign({}, r);

const SKIP_TYPES = [6, 10]; // group joins/leaves, security notices
const LABEL = { 1: 'photo', 2: 'video', 3: 'voice note', 4: 'contact card', 5: 'location', 8: 'document', 11: 'GIF', 13: 'GIF', 14: 'deleted message', 15: 'sticker', 46: 'poll', 54: 'attachment', 59: 'attachment', 66: 'attachment' };

const MSG_SELECT = `SELECT m.Z_PK pk, m.ZCHATSESSION chat, m.ZISFROMME me, m.ZMESSAGETYPE type, m.ZTEXT text, m.ZMESSAGEDATE d, m.ZSTARRED starred,
  c.ZPARTNERNAME chat_name, c.ZSESSIONTYPE stype, g.ZCONTACTNAME member, mi.ZTITLE caption, mi.ZMOVIEDURATION dur, mi.ZMEDIALOCALPATH media
  FROM ZWAMESSAGE m JOIN ZWACHATSESSION c ON c.Z_PK = m.ZCHATSESSION
  LEFT JOIN ZWAGROUPMEMBER g ON g.Z_PK = m.ZGROUPMEMBER LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM`;

const tFile = (pk) => path.join(TDIR, pk + '.txt');
function transcriptOf(pk) { try { return fs.readFileSync(tFile(pk), 'utf8'); } catch (e) { return null; } }

/** Voice notes -> text with whisper.cpp on the Mac (free, local). Cached per message so each is done once. */
export async function transcribe(rows, max = 25) {
  const todo = rows.filter((r) => r.type === 3 && r.media && transcriptOf(r.pk) == null).slice(-max);
  if (!todo.length || !fs.existsSync(MODEL) || !BIN('whisper-cli') || !BIN('ffmpeg')) return 0;
  fs.mkdirSync(TDIR, { recursive: true, mode: 0o700 });
  let n = 0;
  for (const r of todo) {
    const src = path.join(path.dirname(FILE), 'Message', r.media);
    if (!fs.existsSync(src)) continue;
    const wav = path.join(os.tmpdir(), `wa-${r.pk}.wav`);
    try {
      await run(BIN('ffmpeg'), ['-loglevel', 'error', '-y', '-i', src, '-ar', '16000', '-ac', '1', wav], { timeout: 60000 });
      const { stdout } = await run(BIN('whisper-cli'), ['-m', MODEL, '-f', wav, '-nt', '-np', '-l', 'auto'], { timeout: 300000, maxBuffer: 8e6 });
      fs.writeFileSync(tFile(r.pk), stdout.replace(/\s+/g, ' ').trim(), { mode: 0o600 });
      n++;
    } catch (e) { /* leave it untranscribed; tried again next time */ } finally { try { fs.unlinkSync(wav); } catch (e) {} }
  }
  return n;
}

function fmt(r, withChat) {
  let text = r.text || '';
  const label = LABEL[r.type];
  if (label) {
    let tag = `[${label}${r.type === 3 && r.dur ? ` ${Math.round(r.dur)}s` : ''}${r.type === 8 && r.caption ? `: ${r.caption}` : ''}]`;
    const cap = r.type !== 8 && r.caption ? ` ${r.caption}` : '';
    text = `${tag}${cap}${text && text !== r.caption ? ` ${text}` : ''}`;
  }
  if (r.type === 3) { const tr = transcriptOf(r.pk); if (tr) text += ` (said: "${tr}")`; }
  const out = { ts: iso(r.d), from: r.me ? 'Owen' : (r.stype === 1 ? (r.member || 'someone') : r.chat_name), text: text.trim() };
  if (withChat) out.chat = r.chat_name;
  if (r.starred) out.starred = true;
  if (r.media && r.type !== 0) out.file = path.join(path.dirname(FILE), 'Message', r.media);
  return out;
}

const chatType = (t) => (t === 1 ? 'group' : t === 0 ? 'person' : t === 2 ? 'broadcast' : 'other');

export async function waChats(a) {
  const d = await waDb();
  const where = ['c.ZREMOVED = 0', 'c.ZSESSIONTYPE IN (0,1)'];
  const p = [];
  if (a.search) { where.push('(c.ZPARTNERNAME LIKE ? OR c.ZCONTACTJID LIKE ?)'); p.push(`%${a.search}%`, `%${String(a.search).replace(/\D/g, '') || a.search}%`); }
  if (a.people_only) where.push('c.ZSESSIONTYPE = 0');
  if (a.groups_only) where.push('c.ZSESSIONTYPE = 1');
  if (a.unread_only) where.push('c.ZUNREADCOUNT > 0');
  const order = a.sort === 'most_messages' ? 'n DESC' : 'c.ZLASTMESSAGEDATE DESC';
  const rows = d.prepare(`SELECT c.Z_PK id, c.ZPARTNERNAME name, c.ZCONTACTJID jid, c.ZSESSIONTYPE t, c.ZUNREADCOUNT unread, c.ZARCHIVED archived,
      c.ZLASTMESSAGEDATE last, (SELECT coalesce(lm.ZTEXT, '[' || lm.ZMESSAGETYPE || ']') FROM ZWAMESSAGE lm WHERE lm.ZCHATSESSION = c.Z_PK AND lm.ZMESSAGETYPE NOT IN (6,10) ORDER BY lm.ZMESSAGEDATE DESC LIMIT 1) last_text, (SELECT lm.ZISFROMME FROM ZWAMESSAGE lm WHERE lm.ZCHATSESSION = c.Z_PK AND lm.ZMESSAGETYPE NOT IN (6,10) ORDER BY lm.ZMESSAGEDATE DESC LIMIT 1) last_me, s.n, s.first, s.mine
    FROM ZWACHATSESSION c LEFT JOIN (SELECT ZCHATSESSION, count(*) n, min(ZMESSAGEDATE) first, sum(ZISFROMME) mine FROM ZWAMESSAGE GROUP BY ZCHATSESSION) s ON s.ZCHATSESSION = c.Z_PK
    WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ?`).all(...p, lim(a.limit, 40, 600));
  return rows.map((r) => ({ chat_id: r.id, name: r.name, number: /@s\.whatsapp\.net$/.test(r.jid || '') ? '+' + r.jid.split('@')[0] : undefined, type: chatType(r.t),
    messages: r.n || 0, from_owen: r.mine || 0, first_message: iso(r.first), last_message: iso(r.last), last_text: String(r.last_text || '').replace(/^\[(\d+)\]$/, (m, t) => `[${LABEL[t] || 'attachment'}]`).slice(0, 160), last_from: r.last_me ? 'Owen' : 'them',
    unread: r.unread || 0, archived: !!r.archived }));
}

/** Best chat for a name / number / chat id. Exact name first, then people before groups, then most messages. */
export async function waFind(who) {
  const d = await waDb();
  if (/^\d+$/.test(String(who)) && String(who).length < 7) return d.prepare('SELECT Z_PK id, ZPARTNERNAME name, ZSESSIONTYPE t FROM ZWACHATSESSION WHERE Z_PK = ?').all(Number(who));
  const digits = String(who).replace(/\D/g, '');
  return d.prepare(`SELECT c.Z_PK id, c.ZPARTNERNAME name, c.ZSESSIONTYPE t, (SELECT count(*) FROM ZWAMESSAGE WHERE ZCHATSESSION = c.Z_PK) n FROM ZWACHATSESSION c
    WHERE c.ZREMOVED = 0 AND c.ZSESSIONTYPE IN (0,1) AND (c.ZPARTNERNAME LIKE ? ${digits.length >= 6 ? 'OR c.ZCONTACTJID LIKE ?' : ''})
    ORDER BY (lower(c.ZPARTNERNAME) = lower(?)) DESC, c.ZSESSIONTYPE ASC, n DESC LIMIT 12`).all(`%${who}%`, ...(digits.length >= 6 ? [`%${digits}%`] : []), String(who));
}

export async function waHistory(a) {
  const d = await waDb();
  const chats = await waFind(a.chat);
  if (!chats.length) return { error: `No WhatsApp chat matches "${a.chat}". Use whatsapp_chats to list them.` };
  const chat = chats[0];
  const where = ['m.ZCHATSESSION = ?', `m.ZMESSAGETYPE NOT IN (${SKIP_TYPES})`];
  const p = [chat.id];
  if (a.from) { where.push('m.ZMESSAGEDATE >= ?'); p.push(toCd(a.from)); }
  else if (!a.to) { where.push('m.ZMESSAGEDATE >= ?'); p.push(daysAgoCd(lim(a.days, 30, 20000))); }
  if (a.to) { where.push('m.ZMESSAGEDATE < ?'); p.push(toCd(a.to) + 86400); }
  // Oldest-first when a start date is given; otherwise the most recent N.
  const asc = !!a.from && !a.to ? 'ASC' : 'DESC';
  const rows = d.prepare(`${MSG_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.ZMESSAGEDATE ${asc} LIMIT ?`).all(...p, lim(a.limit, 200, 3000)).map(plain);
  if (asc === 'DESC') rows.reverse();
  const transcribed = a.transcribe === false ? 0 : await transcribe(rows, 25);
  const total = d.prepare('SELECT count(*) n, min(ZMESSAGEDATE) f FROM ZWAMESSAGE WHERE ZCHATSESSION = ?').get(chat.id);
  return {
    chat: { chat_id: chat.id, name: chat.name, type: chatType(chat.t), total_messages: total.n, first_message: iso(total.f) },
    other_matches: chats.slice(1).map((c) => `${c.name} (${chatType(c.t)}, id ${c.id})`),
    showing: rows.length, voice_notes_transcribed_now: transcribed, messages: rows.map((r) => fmt(r, false)),
  };
}

export async function waSearch(a) {
  const d = await waDb();
  const q = String(a.query || '').trim();
  if (!q) throw new Error('Give words to search for.');
  // Voice notes already turned into text are searched too.
  let said = [];
  try { const ql = q.toLowerCase(); said = fs.readdirSync(TDIR).filter((f) => /^\d+\.txt$/.test(f) && fs.readFileSync(path.join(TDIR, f), 'utf8').toLowerCase().includes(ql)).map((f) => Number(f.slice(0, -4))).slice(0, 2000); } catch (e) {}
  const where = [`(m.ZTEXT LIKE ? OR mi.ZTITLE LIKE ?${said.length ? ` OR m.Z_PK IN (${said.join(',')})` : ''})`];
  const p = [`%${q}%`, `%${q}%`];
  if (a.chat) { const cs = await waFind(a.chat); if (!cs.length) return { error: `No chat matches "${a.chat}"` }; where.push(`m.ZCHATSESSION IN (${cs.map((c) => c.id)})`); }
  if (a.from) { where.push('m.ZMESSAGEDATE >= ?'); p.push(toCd(a.from)); }
  if (a.to) { where.push('m.ZMESSAGEDATE < ?'); p.push(toCd(a.to) + 86400); }
  if (a.sender === 'owen') where.push('m.ZISFROMME = 1');
  if (a.sender === 'others') where.push('m.ZISFROMME = 0');
  const rows = d.prepare(`${MSG_SELECT} WHERE ${where.join(' AND ')} ORDER BY m.ZMESSAGEDATE DESC LIMIT ?`).all(...p, lim(a.limit, 50, 500)).map(plain);
  const ctx = Math.max(0, Math.min(5, Number(a.context) || 0));
  const total = d.prepare(`SELECT count(*) n FROM ZWAMESSAGE m LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM WHERE ${where.join(' AND ')}`).get(...p).n;
  const near = d.prepare(`${MSG_SELECT} WHERE m.ZCHATSESSION = ? AND m.ZMESSAGETYPE NOT IN (${SKIP_TYPES}) AND m.ZMESSAGEDATE BETWEEN ? AND ? ORDER BY m.ZMESSAGEDATE`);
  return {
    total_matches: total, showing: rows.length,
    matches: rows.map((r) => {
      const o = fmt(r, true);
      if (ctx) {
        const all = near.all(r.chat, r.d - 86400 * 3, r.d + 86400 * 3).map(plain);
        const i = all.findIndex((x) => x.pk === r.pk);
        o.context = all.slice(Math.max(0, i - ctx), i + ctx + 1).map((x) => ({ ...fmt(x, false), ...(x.pk === r.pk ? { match: true } : {}) }));
      }
      return o;
    }),
  };
}

/** One person on WhatsApp: their own chat (stats + recent messages) and groups they are in with Owen. */
export async function waPerson(name, recent = 25) {
  const d = await waDb();
  if (!d) return null;
  const people = (await waFind(name)).filter((c) => c.t === 0).slice(0, 3);
  const out = [];
  for (const c of people) out.push(await (async () => {
    const s = d.prepare('SELECT count(*) n, min(ZMESSAGEDATE) f, max(ZMESSAGEDATE) l, sum(ZISFROMME) mine FROM ZWAMESSAGE WHERE ZCHATSESSION = ?').get(c.id);
    const last = d.prepare(`${MSG_SELECT} WHERE m.ZCHATSESSION = ? AND m.ZMESSAGETYPE NOT IN (${SKIP_TYPES}) ORDER BY m.ZMESSAGEDATE DESC LIMIT ?`).all(c.id, recent).map(plain).reverse();
    await transcribe(last, 10);
    const lastMine = d.prepare('SELECT max(ZMESSAGEDATE) d FROM ZWAMESSAGE WHERE ZCHATSESSION = ? AND ZISFROMME = 1').get(c.id).d;
    const lastTheirs = d.prepare('SELECT max(ZMESSAGEDATE) d FROM ZWAMESSAGE WHERE ZCHATSESSION = ? AND ZISFROMME = 0').get(c.id).d;
    return { chat_id: c.id, name: c.name, total_messages: s.n, from_owen: s.mine, first_message: iso(s.f), last_message: iso(s.l),
      owen_last_wrote: iso(lastMine), they_last_wrote: iso(lastTheirs), waiting_on_owen: (lastTheirs || 0) > (lastMine || 0),
      recent_messages: last.map((r) => fmt(r, false)) };
  })());
  const groups = d.prepare(`SELECT DISTINCT c.Z_PK id, c.ZPARTNERNAME name, c.ZLASTMESSAGEDATE l FROM ZWAGROUPMEMBER g JOIN ZWACHATSESSION c ON c.Z_PK = g.ZCHATSESSION
    WHERE g.ZCONTACTNAME LIKE ? AND c.ZREMOVED = 0 ORDER BY c.ZLASTMESSAGEDATE DESC LIMIT 15`).all(`%${name}%`).map((g) => ({ chat_id: g.id, group: g.name, last_message: iso(g.l) }));
  return { chats: out, shared_groups: groups };
}
