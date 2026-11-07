/**
 * Owen's WhatsApp in the Inbox tool (7 Nov 2026, Owen: "I want it to be free, but good and work like
 * my emails do"). Runs on his Mac (launchd keeps it alive), linked to his WhatsApp as a device, the way
 * WhatsApp Web is. Free; while the Mac sleeps, WhatsApp holds messages and this catches up on waking.
 *
 * Writes chats and messages to Supabase (inbox_wa_chats, inbox_wa_msgs) so the page and his phone see
 * them. A person writing to him (or @-ing him in a group) becomes an inbox row 'wa:<id>' in Reply, like
 * an email; it closes when he answers or reads the chat on his phone. What he does on the page arrives
 * in inbox_wa_outbox (send, read) and is done here within seconds. Never sends anything by itself.
 * Linking: the QR goes to app_settings inbox_wa so the page shows it; scan in WhatsApp > Linked devices.
 * Keys: read at start from Moon's env file (same as mac_sync.py), never stored here.
 */
const fs = require('fs'), os = require('os'), path = require('path');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion, jidNormalizedUser } = require('@whiskeysockets/baileys');
const QR = require('qrcode');
const pino = require('pino');

const HOME = os.homedir();
const CFG = JSON.parse(fs.readFileSync(path.join(HOME, '.moon-snippets/config.json'), 'utf8'));
const ENV = {};
fs.readFileSync(CFG.env_file, 'utf8').split('\n').forEach((l) => { const m = l.trim().match(/^([A-Z0-9_]+)=(.*)$/); if (m) ENV[m[1]] = m[2].trim().replace(/^["']|["']$/g, ''); });
const SB = ENV.VITE_SUPABASE_URL, KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
const AUTH = path.join(HOME, '.moon-snippets/wa-auth');
const NAMES_FILE = path.join(HOME, '.moon-snippets/wa-names.json');
const out = console.log.bind(console);
const log = (...a) => out(new Date().toISOString(), ...a);
// The encryption library prints whole session keys to the console: never let those reach the log file.
console.log = console.info = console.warn = console.debug = () => {};
process.on('unhandledRejection', (e) => log('unhandled', String(e && e.message || e).slice(0, 200)));

// ---- Supabase ----
async function sb(pathq, body, headers = {}) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(SB + pathq, { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const t = await r.text();
      if (!r.ok) throw new Error(r.status + ' ' + t.slice(0, 200));
      return t ? JSON.parse(t) : null;
    } catch (e) { if (i === 3) throw e; await new Promise((ok) => setTimeout(ok, 2000 * (i + 1))); }
  }
}
const q = (sql) => sb('/rest/v1/rpc/run_query', { query: sql });
const x = (sql) => sb('/rest/v1/rpc/run_exec', { query: sql });
const upsert = (table, rows) => rows.length ? sb('/rest/v1/' + table + '?on_conflict=id', rows, { Prefer: 'resolution=merge-duplicates,return=minimal' }) : null;
const lit = (v) => (v === null || v === undefined) ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";
async function status(o) { await x("INSERT INTO app_settings (key, value) VALUES ('inbox_wa', " + lit(JSON.stringify({ ...o, at: new Date().toISOString() })) + "::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value").catch((e) => log('status', e.message)); }

// ---- ids: inbox rows need short ids (wa:<digits>, wa:g<digits> for groups, wa:l<digits> for hidden numbers) ----
function rowId(jid) {
  const [u, d] = String(jid).split('@');
  return 'wa:' + (d === 'g.us' ? 'g' : d === 'lid' ? 'l' : '') + u.replace(/[^0-9-]/g, '').slice(0, 22);
}
const isGroup = (jid) => /@g\.us$/.test(jid);
const isPerson = (jid) => /@(s\.whatsapp\.net|lid)$/.test(jid);

// ---- names ----
let names = {}; try { names = JSON.parse(fs.readFileSync(NAMES_FILE, 'utf8')); } catch (e) {}
let namesDirty = false;
function setName(jid, n) { if (jid && n && names[jid] !== n) { names[jid] = n; namesDirty = true; } }
setInterval(() => { if (namesDirty) { namesDirty = false; fs.writeFileSync(NAMES_FILE, JSON.stringify(names)); } }, 30000);
// Hidden numbers (@lid) map to real ones once WhatsApp says so; his own chat is his notes to self.
let lidMap = names.__lid || {}; names.__lid = lidMap;
function nameOf(jid) {
  if (jid && (jid === me || jid === myLid)) return 'You (notes to self)';
  const real = lidMap[jid];
  const num = String(real || jid).split('@')[0];
  if (/@(s\.whatsapp\.net|lid)$/.test(jid) && contactsMap[num]) return contactsMap[num];
  return names[jid] || (real && names[real]) || (/@lid$/.test(jid) ? (real ? '+' + real.split('@')[0] : 'Unknown number') : '+' + String(jid).split('@')[0]);
}
let myLid = null;
// Names from his Mac Contacts (WhatsApp keeps address-book names to the phone). Refreshed every 6 hours.
const book = require('./contacts');
let contactsMap = {}; const readBook = () => { try { contactsMap = JSON.parse(fs.readFileSync(book.OUT, 'utf8')); } catch (e) {} };
const loadBook = () => { readBook(); book.exportContactsAsync((e, n) => { if (e) log('contacts', String(e.message).slice(0, 120)); else { readBook(); log('contacts', n); } }); };
loadBook(); setInterval(loadBook, 6 * 3600000);

// ---- message text ----
function unwrap(m) { while (m && (m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.documentWithCaptionMessage || m.editedMessage)) m = (m.ephemeralMessage || m.viewOnceMessage || m.viewOnceMessageV2 || m.documentWithCaptionMessage || m.editedMessage).message; return m || {}; }
function textOf(msg) {
  const m = unwrap(msg.message);
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage) return m.extendedTextMessage.text || '';
  if (m.imageMessage) return '📷 Photo' + (m.imageMessage.caption ? ': ' + m.imageMessage.caption : '');
  if (m.videoMessage) return '🎥 Video' + (m.videoMessage.caption ? ': ' + m.videoMessage.caption : '');
  if (m.audioMessage) return '🎤 Voice note';
  if (m.documentMessage) return '📄 ' + (m.documentMessage.fileName || 'Document');
  if (m.stickerMessage) return '(sticker)';
  if (m.contactMessage) return '👤 ' + (m.contactMessage.displayName || 'Contact');
  if (m.locationMessage) return '📍 Location';
  if (m.pollCreationMessage || m.pollCreationMessageV3) return '📊 Poll: ' + ((m.pollCreationMessage || m.pollCreationMessageV3).name || '');
  return null; // reactions, receipts, protocol messages: not shown
}
function mentionsMe(msg, me) {
  const m = unwrap(msg.message), ctx = (m.extendedTextMessage && m.extendedTextMessage.contextInfo) || {};
  return (ctx.mentionedJid || []).some((j) => me && jidNormalizedUser(j) === me) || (ctx.participant && me && jidNormalizedUser(ctx.participant) === me);
}
function ts(msg) { const t = Number(msg.messageTimestamp && msg.messageTimestamp.low !== undefined ? msg.messageTimestamp.low : msg.messageTimestamp); return new Date((t || Date.now() / 1000) * 1000).toISOString(); }

// ---- saving ----
// WhatsApp now sends some chats under a hidden id (@lid) and others under the number: one person, one chat.
function chatOf(msg) {
  let jid = msg.key.remoteJid;
  if (/@lid$/.test(jid)) {
    const pn = msg.key.senderPn || msg.key.remoteJidAlt;
    if (pn && !lidMap[jid]) { lidMap[jid] = jidNormalizedUser(pn); namesDirty = true; }
    if (lidMap[jid]) jid = lidMap[jid];
  }
  return jid;
}
async function saveMsgs(msgs) {
  const rows = [], chats = {};
  for (const msg of msgs) {
    const jid = msg.key && msg.key.remoteJid && chatOf(msg); if (!jid || jid === 'status@broadcast' || /@newsletter$/.test(jid)) continue;
    const t = textOf(msg); if (t === null) continue;
    const from = msg.key.fromMe ? 'me' : jidNormalizedUser(msg.key.participant || jid);
    if (!msg.key.fromMe && msg.pushName) setName(from, msg.pushName);
    const row = { id: rowId(jid) + ':' + msg.key.id, chat_id: jid, from_me: !!msg.key.fromMe, sender: msg.key.fromMe ? 'You' : nameOf(from), text: t.slice(0, 4000), ts: ts(msg) };
    rows.push(row);
    if (!chats[jid] || chats[jid].ts < row.ts) chats[jid] = row;
  }
  for (let i = 0; i < rows.length; i += 400) await upsert('inbox_wa_msgs', rows.slice(i, i + 400));
  const crows = Object.keys(chats).map((jid) => ({ id: jid, name: isGroup(jid) ? (names[jid] || 'Group') : nameOf(jid), is_group: isGroup(jid), last_ts: chats[jid].ts, last_text: chats[jid].text.slice(0, 300), last_from_me: chats[jid].from_me, last_sender: chats[jid].sender, updated_at: new Date().toISOString() }));
  // Only move a chat's "last" forward, never back (history arrives out of order).
  for (const c of crows) await x('INSERT INTO inbox_wa_chats (id, name, is_group, last_ts, last_text, last_from_me, last_sender, updated_at) VALUES (' + [c.id, c.name, c.is_group, c.last_ts, c.last_text, c.last_from_me, c.last_sender].map((v) => typeof v === 'boolean' ? v : lit(v)).join(', ') + ', now())'
    + ' ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, last_ts = EXCLUDED.last_ts, last_text = EXCLUDED.last_text, last_from_me = EXCLUDED.last_from_me, last_sender = EXCLUDED.last_sender, updated_at = now() WHERE inbox_wa_chats.last_ts IS NULL OR inbox_wa_chats.last_ts <= EXCLUDED.last_ts');
  return chats;
}

/** A person waiting on Owen: one inbox row per chat, like an email thread. Closes when he answers. */
async function touchInbox(jid, last, me, mentioned) {
  const id = rowId(jid);
  if (last.from_me) { await x("UPDATE inbox_emails SET status = 'done', done_at = now(), gmail_done = true WHERE id = " + lit(id) + " AND status = 'open'"); return; }
  if (!(isPerson(jid) || (isGroup(jid) && mentioned))) return;
  const recent = await q('SELECT from_me, sender, text, ts FROM inbox_wa_msgs WHERE chat_id = ' + lit(jid) + ' ORDER BY ts DESC LIMIT 8') || [];
  const thread = recent.reverse().map((m) => 'From: ' + (m.from_me ? 'Owen <me>' : m.sender + ' <' + id + '>') + '\nDate: ' + m.ts + '\n\n' + m.text).join('\n\n=====\n\n');
  const who = isGroup(jid) ? last.sender + ' in ' + (names[jid] || 'a group') : nameOf(jid);
  await x('INSERT INTO inbox_emails (id, account, kind, category, from_name, from_email, to_email, subject, snippet, thread_text, received_at, gmail_url, why, status, sorted_at) VALUES ('
    + [id, 'whatsapp', 'in', 'reply', who, id + '@whatsapp', '', isGroup(jid) ? (names[jid] || 'Group') : 'WhatsApp', last.text.slice(0, 300), thread, last.ts, 'whatsapp://send?phone=' + (isPerson(jid) && /s\.whatsapp/.test(jid) ? jid.split('@')[0] : ''), isGroup(jid) ? 'Mentioned you on WhatsApp' : 'WhatsApp', 'open'].map(lit).join(', ') + ', now())'
    + " ON CONFLICT (id) DO UPDATE SET from_name = EXCLUDED.from_name, snippet = EXCLUDED.snippet, thread_text = EXCLUDED.thread_text, received_at = EXCLUDED.received_at, status = 'open', gmail_done = false, done_at = NULL, draft_text = NULL WHERE inbox_emails.received_at < EXCLUDED.received_at");
}

// ---- WhatsApp ----
let sock = null, me = null, busy = false;
async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));
  sock = makeWASocket({ auth: state, version, logger: pino({ level: process.env.WA_LOG || 'warn' }), browser: Browsers.macOS('Desktop'), markOnlineOnConnect: false, syncFullHistory: false, shouldSyncHistoryMessage: () => true }); // recent history comes at linking (full history makes WhatsApp refuse the link): keep 3 weeks
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    if (u.qr) { log('QR ready, scan it on the Inbox page'); await status({ state: 'qr', qr: await QR.toDataURL(u.qr, { margin: 1, width: 280 }) }); }
    if (u.connection === 'open') { me = jidNormalizedUser(sock.user.id); myLid = sock.user.lid ? jidNormalizedUser(sock.user.lid) : null; log('linked as', me); await status({ state: 'open', me: me.split('@')[0] }); }
    if (u.connection === 'close') {
      const code = u.lastDisconnect && u.lastDisconnect.error && u.lastDisconnect.error.output ? u.lastDisconnect.error.output.statusCode : 0;
      log('closed', code);
      if (code === DisconnectReason.loggedOut) { await status({ state: 'loggedout' }); fs.rmSync(AUTH, { recursive: true, force: true }); }
      else await status({ state: 'reconnecting' });
      setTimeout(start, code === DisconnectReason.loggedOut ? 2000 : 5000);
    }
  });
  const contact = (c) => { setName(c.id, c.name || c.notify || c.verifiedName); if (c.lid && c.jid) { lidMap[c.lid] = c.jid; namesDirty = true; if (c.name) setName(c.lid, c.name); } };
  sock.ev.on('contacts.upsert', (cs) => cs.forEach(contact));
  sock.ev.on('contacts.update', (cs) => cs.forEach((c) => setName(c.id, c.name || c.notify)));
  sock.ev.on('groups.upsert', (gs) => gs.forEach((g) => setName(g.id, g.subject)));
  sock.ev.on('groups.update', (gs) => gs.forEach((g) => g.subject && setName(g.id, g.subject)));
  // First link and after sleep: what WhatsApp holds comes in as history. Recent only.
  sock.ev.on('messaging-history.set', async ({ chats, contacts, messages, syncType, progress }) => {
    log('history event', syncType, progress, (messages || []).length);
    try {
      (contacts || []).forEach(contact);
      (chats || []).forEach((c) => c.name && setName(c.id, c.name));
      const cut = Date.now() - 3 * 365 * 86400000; // keep it all, like the app (Owen 7 Nov)
      const recent = (messages || []).filter((m) => new Date(ts(m)).getTime() > cut);
      await saveMsgs(recent);
      for (const c of chats || []) if (c.unreadCount !== undefined) {
        await x('UPDATE inbox_wa_chats SET unread = ' + Number(c.unreadCount || 0) + ' WHERE id = ' + lit(c.id));
        // Unread from a person when he linked: waiting on him, like an unread email.
        if (c.unreadCount > 0 && isPerson(c.id)) { const l = (await q('SELECT from_me, sender, text, ts FROM inbox_wa_msgs WHERE chat_id = ' + lit(c.id) + ' ORDER BY ts DESC LIMIT 1') || [])[0]; if (l && !l.from_me) await touchInbox(c.id, l, me, false); }
      }
      log('history', recent.length, 'of', (messages || []).length, 'messages,', (chats || []).length, 'chats');
    } catch (e) { log('history', e.message); }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    log('upsert', type, messages.length);
    try {
      const chats = await saveMsgs(messages);
      if (type !== 'notify' && type !== 'append') return;
      for (const jid of Object.keys(chats)) {
        const mentioned = messages.some((m) => chatOf(m) === jid && mentionsMe(m, me));
        if (isGroup(jid) && !names[jid]) { try { const md = await sock.groupMetadata(jid); setName(jid, md.subject); await x('UPDATE inbox_wa_chats SET name = ' + lit(md.subject) + ' WHERE id = ' + lit(jid)); } catch (e) {} }
        if (!chats[jid].from_me) await x('UPDATE inbox_wa_chats SET unread = unread + 1 WHERE id = ' + lit(jid));
        await touchInbox(jid, chats[jid], me, mentioned);
      }
    } catch (e) { log('upsert', e.message); }
  });
  // Read on his phone: the chat leaves the inbox, like Slack.
  sock.ev.on('chats.update', async (us) => {
    for (const c of us) {
      if (c.unreadCount === 0) { await x('UPDATE inbox_wa_chats SET unread = 0 WHERE id = ' + lit(c.id)).catch(() => {}); await x("UPDATE inbox_emails SET status = 'done', done_at = now(), gmail_done = true WHERE id = " + lit(rowId(c.id)) + " AND status = 'open'").catch(() => {}); }
    }
  });
}

// Names arrive after the chats (WhatsApp sends contacts a bit later): fix any chat still showing a number.
async function renameSweep() {
  if (!me) return;
  try {
    // Fold any hidden-id chat we now know the number for into that number's chat.
    for (const lid of Object.keys(lidMap)) {
      const pn = lidMap[lid]; if (!/@lid$/.test(lid) || !pn) continue;
      const has = (await q('SELECT 1 AS n FROM inbox_wa_chats WHERE id = ' + lit(lid)) || [])[0]; if (!has) continue;
      const pre = rowId(pn) + ':';
      await x('DELETE FROM inbox_wa_msgs WHERE chat_id = ' + lit(lid) + " AND split_part(id, ':', 3) IN (SELECT split_part(id, ':', 3) FROM inbox_wa_msgs WHERE chat_id = " + lit(pn) + ')');
      await x('UPDATE inbox_wa_msgs SET chat_id = ' + lit(pn) + ', id = ' + lit(pre) + " || split_part(id, ':', 3) WHERE chat_id = " + lit(lid));
      await x('INSERT INTO inbox_wa_chats (id, name, is_group, unread) SELECT ' + lit(pn) + ', name, false, unread FROM inbox_wa_chats WHERE id = ' + lit(lid) + ' ON CONFLICT (id) DO UPDATE SET unread = greatest(inbox_wa_chats.unread, EXCLUDED.unread)');
      await x('UPDATE inbox_wa_chats c SET last_ts = m.ts, last_text = left(m.text, 300), last_from_me = m.from_me, last_sender = m.sender FROM (SELECT ts, text, from_me, sender FROM inbox_wa_msgs WHERE chat_id = ' + lit(pn) + ' ORDER BY ts DESC LIMIT 1) m WHERE c.id = ' + lit(pn));
      await x('DELETE FROM inbox_wa_chats WHERE id = ' + lit(lid));
      await x("UPDATE inbox_emails SET status = 'done', done_at = now(), gmail_done = true WHERE id = " + lit(rowId(lid)) + " AND status = 'open'");
      log('merged', lid, 'into', pn);
    }
    const rows = await q("SELECT id, name FROM inbox_wa_chats WHERE name LIKE '+%' OR name IN ('Group', 'Unknown number') OR id = " + lit(me) + (myLid ? ' OR id = ' + lit(myLid) : '')) || [];
    for (const r of rows) {
      let n = isGroup(r.id) ? names[r.id] : nameOf(r.id);
      if (isGroup(r.id) && !n) { try { n = (await sock.groupMetadata(r.id)).subject; setName(r.id, n); } catch (e) {} }
      if (n && n !== r.name) { await x('UPDATE inbox_wa_chats SET name = ' + lit(n) + ' WHERE id = ' + lit(r.id)); await x('UPDATE inbox_emails SET from_name = ' + lit(n) + ' WHERE id = ' + lit(rowId(r.id))); }
    }
  } catch (e) { log('rename', e.message); }
}
setInterval(renameSweep, 60000); setTimeout(renameSweep, 20000);

// ---- What Owen did on the page ----
async function outbox() {
  if (busy || !sock || !me) return; busy = true;
  try {
    const jobs = await q('SELECT id, chat_id, kind, text FROM inbox_wa_outbox WHERE done_at IS NULL ORDER BY id LIMIT 10') || [];
    for (const j of jobs) {
      let res = 'ok';
      try {
        if (j.kind === 'send') { const s = await sock.sendMessage(j.chat_id, { text: j.text }); await saveMsgs([s]); await touchInbox(j.chat_id, { from_me: true }, me, false); }
        else if (j.kind === 'older') {
          const o = (await q('SELECT id, from_me, ts FROM inbox_wa_msgs WHERE chat_id = ' + lit(j.chat_id) + ' ORDER BY ts ASC LIMIT 1') || [])[0];
          if (o) await sock.fetchMessageHistory(50, { remoteJid: j.chat_id, id: o.id.split(':').pop(), fromMe: !!o.from_me }, Math.floor(new Date(o.ts).getTime() / 1000));
        }
        else if (j.kind === 'read') {
          const last = await q('SELECT id FROM inbox_wa_msgs WHERE chat_id = ' + lit(j.chat_id) + ' AND NOT from_me ORDER BY ts DESC LIMIT 5') || [];
          const keys = last.map((m) => ({ remoteJid: j.chat_id, id: m.id.split(':').pop(), fromMe: false }));
          if (keys.length) await sock.readMessages(keys);
          await x('UPDATE inbox_wa_chats SET unread = 0 WHERE id = ' + lit(j.chat_id));
        }
      } catch (e) { res = 'error: ' + String(e.message || e).slice(0, 200); }
      await x('UPDATE inbox_wa_outbox SET done_at = now(), result = ' + lit(res) + ' WHERE id = ' + Number(j.id));
    }
  } catch (e) { log('outbox', e.message); }
  busy = false;
}
setInterval(outbox, 3000);
setInterval(() => { if (me) status({ state: 'open', me: me.split('@')[0] }); }, 5 * 60000); // heartbeat once linked (never over the QR)

start().catch((e) => { log('start', e.message); process.exit(1); });
