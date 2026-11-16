#!/usr/bin/env node
/**
 * Inbox MCP (Owen 16 Nov 2026): lets any Claude chat on this Mac see his email history (all 5 inboxes),
 * tasks, notes, reminders and WhatsApp history. READ ONLY: nothing here sends, marks, labels, bins or deletes.
 * Keys are read at start from Moon's env file (same as the WhatsApp bridge), never stored in this repo (it is public).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { waDb, waChats, waHistory, waSearch, waPerson } from './wa.js';

const HOME = os.homedir();
const CFG = JSON.parse(fs.readFileSync(path.join(HOME, '.moon-snippets/config.json'), 'utf8'));
const ENV = {};
fs.readFileSync(CFG.env_file, 'utf8').split('\n').forEach((l) => {
  const m = l.trim().match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) ENV[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
});
const SB_URL = ENV.VITE_SUPABASE_URL || ENV.SUPABASE_URL;
const SB_KEY = ENV.SUPABASE_SERVICE_ROLE_KEY;
const SCRIPT = 'https://script.google.com/macros/s/AKfycbzUIxAgrR4bZZCPNQ-Eqbc93gq2Tt_CMG5TXIixKmP0P63n_KX1zRMyCs8cHf7_GtFG/exec';
const SECRET = fs.readFileSync(path.join(HOME, '.moon-snippets/inbox_tool_secret'), 'utf8').trim();
const ACCOUNTS = ['personal', 'tez', 'songdrafts', 'omellette', 'rt'];

// ---- helpers ----
async function sb(table, query) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${query}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!r.ok) throw new Error(`Database ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
// PostgREST filter value: strip characters that break or( ) / like syntax.
const clean = (s) => String(s || '').replace(/[,()*%\\:"]/g, ' ').trim().slice(0, 100);
const enc = encodeURIComponent;
const clamp = (n, d, max) => Math.max(1, Math.min(max, Number(n) || d));
const since = (days) => new Date(Date.now() - clamp(days, 30, 3650) * 864e5).toISOString();

async function script(op, args) {
  const kt = String(Date.now());
  const ks = crypto.createHmac('sha256', SECRET).update(kt).digest('hex');
  const r = await fetch(SCRIPT, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ action: 'inboxApi', kt, ks, op, args }) });
  const d = await r.json();
  if (d.ok === false || d.error) throw new Error(String(d.error || 'Apps Script error'));
  return d.data !== undefined ? d.data : d;
}

async function findChats(who) {
  const w = clean(who);
  if (!w) return [];
  const digits = w.replace(/\D/g, '');
  const or = [`name.ilike.*${w}*`];
  if (digits.length >= 6) or.push(`id.ilike.*${digits}*`);
  return sb('inbox_wa_chats', `select=id,name,is_group,last_ts,unread&or=(${enc(or.join(','))})&order=last_ts.desc.nullslast&limit=10`);
}

// ---- tools ----
const TOOLS = [
  {
    name: 'search_email',
    description: "Search Owen's full Gmail history live, across all 5 inboxes (personal, tez = hello@wearetez.com, songdrafts, omellette, rt = RideTandem) or one. Takes any Gmail search, e.g. 'from:joe', 'Kahuna', 'subject:invoice after:2026/10/01', 'to:someone@x.com'. Returns threads newest first with account and thread_id; use read_email_thread for the full text.",
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Gmail search query' },
      account: { type: 'string', enum: ACCOUNTS, description: 'Only this inbox (leave out for all 5)' },
      limit: { type: 'number', description: 'Threads per inbox, default 10, max 25' },
    }, required: ['query'] },
  },
  {
    name: 'read_email_thread',
    description: 'Read every message in one Gmail thread as plain text (quoted history cut). Use account + thread_id from search_email.',
    inputSchema: { type: 'object', properties: {
      account: { type: 'string', enum: ACCOUNTS }, thread_id: { type: 'string' },
    }, required: ['account', 'thread_id'] },
  },
  {
    name: 'inbox_piles',
    description: "What Owen's Inbox tool has sorted right now: Reply (people waiting on him), To do, Promised (things he said he'd do), Chase (waiting on others), Fix, Learn, Noise. Open items by default, newest first, with any reply already drafted in his voice.",
    inputSchema: { type: 'object', properties: {
      pile: { type: 'string', enum: ['reply', 'todo', 'promise', 'chase', 'fix', 'learn', 'noise'], description: 'One pile (leave out for Reply, To do, Promised, Chase)' },
      search: { type: 'string', description: 'Only rows whose sender, subject or text contains this' },
      account: { type: 'string', enum: [...ACCOUNTS, 'slack', 'whatsapp'], description: 'Only this inbox (slack = Slack messages the tool pulled)' },
      include_closed: { type: 'boolean', description: 'Also done/handled items (history)' },
      limit: { type: 'number', description: 'Default 40, max 200' },
    } },
  },
  {
    name: 'tasks',
    description: "Everything on Owen's plate in one go: open Inbox tasks (from his briefs), Promised and Chase items, Apple Reminders not done, and sticky-note items waiting for each project chat.",
    inputSchema: { type: 'object', properties: {
      include_done: { type: 'boolean', description: 'Also include finished tasks and reminders' },
    } },
  },
  {
    name: 'search_notes',
    description: "Search Owen's Apple Notes (synced from his Mac) by words in the title or body.",
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' }, limit: { type: 'number', description: 'Default 15, max 40' },
    }, required: ['query'] },
  },
  {
    name: 'whatsapp_chats',
    description: "List Owen's WhatsApp chats (568+, people and groups) from the WhatsApp Mac app, full history back to 2015. Each has message count, first and last message, last text, unread. Sort by recent or most messages.",
    inputSchema: { type: 'object', properties: {
      search: { type: 'string', description: 'Only chats whose name or number contains this' },
      people_only: { type: 'boolean' }, groups_only: { type: 'boolean' }, unread_only: { type: 'boolean' },
      sort: { type: 'string', enum: ['recent', 'most_messages'] },
      limit: { type: 'number', description: 'Default 40, max 600' },
    } },
  },
  {
    name: 'whatsapp_history',
    description: "Read one WhatsApp chat, full history back to 2015 (photos and documents shown as [tags] with captions and local file paths; voice notes are turned into text on the Mac and shown as (said: ...), up to 25 new ones per call, cached). Give a name ('Laura', 'Joe', a group name), a number, or chat_id from whatsapp_chats. Default: last 30 days. Use from/to for any period: from alone reads forward from that date; to alone or both reads the most recent N in the range.",
    inputSchema: { type: 'object', properties: {
      chat: { type: 'string', description: 'Name, number or chat_id' },
      from: { type: 'string', description: 'Start date YYYY-MM-DD' },
      to: { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
      days: { type: 'number', description: 'Last N days when no dates given (default 30)' },
      limit: { type: 'number', description: 'Max messages, default 200, max 3000' },
      transcribe: { type: 'boolean', description: 'Turn voice notes into text (default true; false is faster)' },
    }, required: ['chat'] },
  },
  {
    name: 'whatsapp_search',
    description: 'Search every WhatsApp message, caption and transcribed voice note since 2015 for words. Filter by chat, dates, or who sent it; add context to see the messages either side of each match.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' },
      chat: { type: 'string', description: 'Only this chat (name, number or chat_id)' },
      from: { type: 'string', description: 'YYYY-MM-DD' }, to: { type: 'string', description: 'YYYY-MM-DD' },
      sender: { type: 'string', enum: ['owen', 'others'] },
      context: { type: 'number', description: 'Messages either side of each match, 0-5' },
      limit: { type: 'number', description: 'Default 50, max 500' },
    }, required: ['query'] },
  },
  {
    name: 'person',
    description: "Everything about one person in one call: their WhatsApp chat (totals, first/last contact, whether they are waiting on Owen, recent messages) and shared groups, Gmail threads with them across all 5 inboxes, open Inbox items (reply/promised/chase), tasks and reminders that mention them, and notes that mention them. Give a name and/or email.",
    inputSchema: { type: 'object', properties: {
      name: { type: 'string' }, email: { type: 'string' },
      recent: { type: 'number', description: 'Recent WhatsApp messages to include, default 25, max 200' },
    } },
  },
  {
    name: 'search_everything',
    description: "One search across all of Owen's channels at once: Gmail (all 5 inboxes), WhatsApp (since 2015), Apple Notes, tasks and reminders, and the Inbox tool's piles (including Slack messages it pulled). Use first when you don't know where something was said.",
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Words to find' },
      days: { type: 'number', description: 'Only the last N days (optional; Gmail and WhatsApp)' },
    }, required: ['query'] },
  },
];

const HANDLERS = {
  async whatsapp_chats(a) { return (await waDb()) ? waChats(a) : HANDLERS._sb_whatsapp_chats(a); },
  async whatsapp_history(a) { return (await waDb()) ? waHistory(a) : HANDLERS._sb_whatsapp_history(a); },
  async whatsapp_search(a) { return (await waDb()) ? waSearch(a) : HANDLERS._sb_whatsapp_search(a); },
  async person(a) {
    const name = String(a.name || '').trim(), email = String(a.email || '').trim().toLowerCase();
    if (!name && !email) throw new Error('Give a name or an email.');
    const n = clean(name), e = clean(email).replace(/ /g, '');
    // Email addresses: given, or learnt from mail the Inbox tool has seen from that name.
    let addrs = email ? [email] : [];
    if (!addrs.length && n) {
      const seen = await sb('inbox_emails', `select=from_email&from_name=ilike.${enc(`*${n}*`)}&from_email=not.is.null&order=received_at.desc&limit=50`);
      addrs = [...new Set(seen.map((r) => String(r.from_email).toLowerCase()).filter((x) => x.includes('@')))].slice(0, 3);
    }
    const gq = addrs.length ? addrs.map((x) => `from:${x} OR to:${x}`).join(' OR ') : `"${name}"`;
    const term = n || e;
    const orIn = [`from_name.ilike.*${term}*`, `subject.ilike.*${term}*`, `snippet.ilike.*${term}*`, ...(e ? [`from_email.ilike.*${e}*`] : addrs.map((x) => `from_email.eq.${clean(x).replace(/ /g, '')}`))];
    const settle = (p) => p.then((v) => v, (err) => ({ error: String(err.message || err) }));
    const [wa, gmail, inbox, tasks, reminders, notes] = await Promise.all([
      settle(name ? waPerson(name, clamp(a.recent, 25, 200)) : Promise.resolve(null)),
      settle(script('gmailSearch', { q: gq, limit: 8 })),
      settle(sb('inbox_emails', `select=id,account,category,status,from_name,from_email,subject,snippet,received_at,draft_text&status=in.(open,snoozed)&or=(${enc(orIn.join(','))})&order=received_at.desc&limit=20`)),
      settle(term ? sb('inbox_tasks', `select=id,text,due,done&done=eq.false&text=ilike.${enc(`*${term}*`)}&limit=20`) : Promise.resolve([])),
      settle(term ? sb('inbox_mac', `select=title,due,list&kind=eq.reminder&done=eq.false&or=(${enc(`title.ilike.*${term}*,body.ilike.*${term}*`)})&limit=20`) : Promise.resolve([])),
      settle(term ? sb('inbox_mac', `select=id,title,modified_at,body&kind=eq.note&or=(${enc(`title.ilike.*${term}*,body.ilike.*${term}*`)})&order=modified_at.desc&limit=8`) : Promise.resolve([])),
    ]);
    return {
      email_addresses: addrs, whatsapp: wa, gmail_threads: gmail, open_inbox_items: inbox, tasks, reminders,
      notes: Array.isArray(notes) ? notes.map((x) => ({ ...x, body: String(x.body || '').slice(0, 400) })) : notes,
    };
  },
  async search_everything(a) {
    const q = String(a.query || '').trim();
    const s = clean(q);
    if (!s) throw new Error('Give words to search for.');
    const days = Number(a.days) || 0;
    const fromDate = days ? new Date(Date.now() - days * 864e5).toISOString().slice(0, 10) : undefined;
    const settle = (p) => p.then((v) => v, (err) => ({ error: String(err.message || err) }));
    const [gmail, wa, notes, tasks, reminders, inbox] = await Promise.all([
      settle(script('gmailSearch', { q: q + (days ? ` newer_than:${days}d` : ''), limit: 5 })),
      settle(HANDLERS.whatsapp_search({ query: q, from: fromDate, limit: 30 })),
      settle(sb('inbox_mac', `select=id,title,modified_at,body&kind=eq.note&or=(${enc(`title.ilike.*${s}*,body.ilike.*${s}*`)})&order=modified_at.desc&limit=10`)),
      settle(sb('inbox_tasks', `select=id,text,due,done&text=ilike.${enc(`*${s}*`)}&order=created_at.desc&limit=20`)),
      settle(sb('inbox_mac', `select=title,due,list,done&kind=eq.reminder&or=(${enc(`title.ilike.*${s}*,body.ilike.*${s}*`)})&limit=20`)),
      settle(sb('inbox_emails', `select=id,account,category,status,from_name,subject,snippet,received_at&or=(${enc(`from_name.ilike.*${s}*,subject.ilike.*${s}*,snippet.ilike.*${s}*`)})&order=received_at.desc&limit=25`)),
    ]);
    return {
      gmail, whatsapp: wa,
      notes: Array.isArray(notes) ? notes.map((x) => ({ ...x, body: String(x.body || '').slice(0, 300) })) : notes,
      tasks, reminders, inbox_tool_items_incl_slack: inbox,
    };
  },
  async search_email(a) {
    return script('gmailSearch', { q: String(a.query || ''), account: a.account || '', limit: a.limit || 10 });
  },
  async read_email_thread(a) {
    return script('gmailThread', { account: a.account, thread_id: a.thread_id });
  },
  async inbox_piles(a) {
    const piles = a.pile ? [a.pile] : ['reply', 'todo', 'promise', 'chase'];
    let q = `select=id,account,category,status,from_name,from_email,subject,snippet,thread_text,draft_text,received_at,snooze_until,why,gmail_url`
      + `&category=in.(${piles.join(',')})&order=received_at.desc&limit=${clamp(a.limit, 40, 200)}`;
    if (!a.include_closed) q += '&status=in.(open,snoozed)';
    if (a.account) q += `&account=eq.${enc(a.account)}`;
    const s = clean(a.search);
    if (s) q += `&or=(${enc(`from_name.ilike.*${s}*,from_email.ilike.*${s}*,subject.ilike.*${s}*,snippet.ilike.*${s}*`)})`;
    const rows = await sb('inbox_emails', q);
    return rows.map((r) => ({ ...r, thread_text: r.thread_text ? r.thread_text.slice(-1500) : undefined }));
  },
  async tasks(a) {
    const done = !!a.include_done;
    const [tasks, emails, reminders, sticky, stickies] = await Promise.all([
      sb('inbox_tasks', `select=id,text,due,done,source,email_id,created_at${done ? '' : '&done=eq.false'}&order=due.asc.nullslast,created_at.desc&limit=200`),
      sb('inbox_emails', `select=id,account,category,status,from_name,subject,snippet,received_at,snooze_until&category=in.(promise,chase,todo)&status=in.(open,snoozed)&order=received_at.desc&limit=100`),
      sb('inbox_mac', `select=id,title,body,list,due,done,modified_at&kind=eq.reminder${done ? '' : '&done=eq.false'}&order=due.asc.nullslast&limit=200`),
      sb('inbox_sticky_items', `select=id,sticky_id,kind,title,body,added_at&cleared_at=is.null&order=added_at.desc&limit=200`),
      sb('inbox_sticky', 'select=id,name'),
    ]);
    const names = Object.fromEntries(stickies.map((s) => [s.id, s.name]));
    return {
      inbox_tasks: tasks,
      promised_chase_todo_emails: emails.map((e) => ({ ...e, snippet: String(e.snippet || '').slice(0, 200) })),
      apple_reminders: reminders.map((r) => ({ ...r, body: r.body ? String(r.body).slice(0, 300) : undefined })),
      sticky_notes_for_chats: sticky.map((s) => ({ ...s, body: s.body ? String(s.body).slice(0, 200) : undefined, chat: names[s.sticky_id] || s.sticky_id })),
    };
  },
  async search_notes(a) {
    const s = clean(a.query);
    if (!s) throw new Error('Give words to search for.');
    const rows = await sb('inbox_mac', `select=id,title,body,list,modified_at&kind=eq.note&or=(${enc(`title.ilike.*${s}*,body.ilike.*${s}*`)})&order=modified_at.desc&limit=${clamp(a.limit, 15, 40)}`);
    return rows.map((r) => ({ ...r, body: String(r.body || '').slice(0, 6000) }));
  },
  async _sb_whatsapp_chats(a) {
    let q = `select=id,name,is_group,last_ts,last_text,last_from_me,last_sender,unread&order=last_ts.desc.nullslast&limit=${clamp(a.limit, 40, 200)}`;
    if (a.unread_only) q += '&unread=gt.0';
    if (a.people_only) q += '&is_group=eq.false';
    const s = clean(a.search);
    if (s) q += `&name=ilike.${enc(`*${s}*`)}`;
    return sb('inbox_wa_chats', q);
  },
  async _sb_whatsapp_history(a) {
    let chats = /@/.test(String(a.chat)) ? await sb('inbox_wa_chats', `select=id,name,is_group,last_ts&id=eq.${enc(a.chat)}`) : await findChats(a.chat);
    if (!chats.length) return { error: `No WhatsApp chat matches "${a.chat}". Try whatsapp_chats to list them.` };
    const exact = chats.filter((c) => String(c.name || '').toLowerCase() === String(a.chat).toLowerCase());
    const chat = (exact[0] || chats[0]);
    const rows = await sb('inbox_wa_msgs', `select=from_me,sender,text,ts,reactions&chat_id=eq.${enc(chat.id)}&ts=gte.${enc(since(a.days || 30))}&order=ts.desc&limit=${clamp(a.limit, 150, 1000)}`);
    rows.reverse();
    return {
      chat: { id: chat.id, name: chat.name, is_group: chat.is_group },
      other_matches: chats.filter((c) => c.id !== chat.id).map((c) => c.name),
      messages: rows.map((m) => ({ ts: m.ts, from: m.from_me ? 'Owen' : (m.sender || chat.name), text: m.text, ...(m.reactions && Object.keys(m.reactions).length ? { reactions: m.reactions } : {}) })),
    };
  },
  async _sb_whatsapp_search(a) {
    const s = clean(a.query);
    if (!s) throw new Error('Give words to search for.');
    const rows = await sb('inbox_wa_msgs', `select=chat_id,from_me,sender,text,ts&text=ilike.${enc(`*${s}*`)}&ts=gte.${enc(since(a.days || 90))}&order=ts.desc&limit=${clamp(a.limit, 50, 300)}`);
    const ids = [...new Set(rows.map((r) => r.chat_id))];
    const chats = ids.length ? await sb('inbox_wa_chats', `select=id,name&id=in.(${ids.map((i) => `"${i}"`).map(enc).join(',')})`) : [];
    const names = Object.fromEntries(chats.map((c) => [c.id, c.name]));
    return rows.map((r) => ({ chat: names[r.chat_id] || r.chat_id, ts: r.ts, from: r.from_me ? 'Owen' : (r.sender || names[r.chat_id]), text: r.text }));
  },
};

const server = new Server({ name: 'inbox', version: '1.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fn = HANDLERS[req.params.name];
  if (!fn) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }] };
  try {
    const out = await fn(req.params.arguments || {});
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] };
  }
});
await server.connect(new StdioServerTransport());
