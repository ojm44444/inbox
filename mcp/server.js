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
    description: "List Owen's WhatsApp chats (people and groups), most recent first, with the last message and unread count. History starts 18 Oct 2026 (when the bridge was linked).",
    inputSchema: { type: 'object', properties: {
      search: { type: 'string', description: 'Only chats whose name or number contains this' },
      unread_only: { type: 'boolean' },
      people_only: { type: 'boolean', description: 'Leave out groups' },
      limit: { type: 'number', description: 'Default 40, max 200' },
    } },
  },
  {
    name: 'whatsapp_history',
    description: "Read the messages in one WhatsApp chat, oldest to newest. Give a name (e.g. 'Laura', 'Joe', a group name) or a number, or the chat id from whatsapp_chats.",
    inputSchema: { type: 'object', properties: {
      chat: { type: 'string', description: 'Name, number or chat id' },
      days: { type: 'number', description: 'How far back, default 30' },
      limit: { type: 'number', description: 'Most recent N messages, default 150, max 1000' },
    }, required: ['chat'] },
  },
  {
    name: 'whatsapp_search',
    description: 'Search the text of every WhatsApp message (all chats) for words. Returns matches with chat name, sender and time.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string' },
      days: { type: 'number', description: 'How far back, default 90' },
      limit: { type: 'number', description: 'Default 50, max 300' },
    }, required: ['query'] },
  },
];

const HANDLERS = {
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
  async whatsapp_chats(a) {
    let q = `select=id,name,is_group,last_ts,last_text,last_from_me,last_sender,unread&order=last_ts.desc.nullslast&limit=${clamp(a.limit, 40, 200)}`;
    if (a.unread_only) q += '&unread=gt.0';
    if (a.people_only) q += '&is_group=eq.false';
    const s = clean(a.search);
    if (s) q += `&name=ilike.${enc(`*${s}*`)}`;
    return sb('inbox_wa_chats', q);
  },
  async whatsapp_history(a) {
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
  async whatsapp_search(a) {
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
