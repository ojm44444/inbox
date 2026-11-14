// The Inbox's Gmail and Slack sync, off Google (6 Nov 2026, Owen: Google's 20,000 calls a day
// kept running out and took the inbox down with it). Runs in Supabase every 2 minutes (pg_cron).
// Does the four Composio inboxes (tez, songdrafts, omellette, rt), chases and Slack. The personal
// Gmail stays on the Moon Google script (GmailApp, no web calls). Same rules as EMAIL_INBOX.js:
// never archives, never sends, never bins. Only Owen's own scheduler can start it.
const SB = Deno.env.get('SUPABASE_URL')!, KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const ACCOUNTS: Record<string, string> = { tez: 'ca_HzeBA4nWQWtD', songdrafts: 'ca_hWqmWU9-D93s', omellette: 'ca_p4BZlTJhtt89', rt: 'ca_xZnnlpdlAPFW' };
const SLACK = 'ca_uTf-_PAXoVgn';
const ROBOT = /no-?reply|do-?not-?reply|notification|alerts?@|mailer|bounce|newsletter|news@|updates?@|support@|billing@|receipts?@|team@|hello@|info@|marketing@|hubspotemail|list-manage/i;
const OWN = /@wearetez\.com$|^wearetezband@gmail\.com$|^ojm221100@gmail\.com$|^songdraftsapp@gmail\.com$|@songdrafts\.com$|^omellettemusic@gmail\.com$|^owen@ridetandem\.co$/i;
let COMPOSIO = '';

async function rpc(fn: string, sql: string) {
  const r = await fetch(SB + '/rest/v1/rpc/' + fn, { method: 'POST', headers: { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql }) });
  if (!r.ok) throw new Error('db ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return await r.json();
}
const q = (sql: string) => rpc('run_query', sql).then((x: any) => x || []);
const x = (sql: string) => rpc('run_exec', sql);
const lit = (v: unknown) => v === null || v === undefined || v === '' ? 'NULL' : "'" + String(v).replace(/'/g, "''") + "'";

async function proxy(acct: string, endpoint: string, method = 'GET', body?: unknown) {
  const p: any = { connected_account_id: acct, endpoint, method };
  if (body !== undefined) p.body = body;
  const r = await fetch('https://backend.composio.dev/api/v3/tools/execute/proxy', { method: 'POST', headers: { 'x-api-key': COMPOSIO, 'Content-Type': 'application/json' }, body: JSON.stringify(p) });
  const j: any = await r.json().catch(() => ({}));
  const st = Number(j.status || r.status);
  if (!r.ok || st >= 300 || j.error) throw new Error(endpoint.split('?')[0].split('/').slice(-2).join('/') + ' ' + st + ': ' + JSON.stringify(j.error || j.data || j).slice(0, 160));
  return j.data || {};
}
const gmail = (a: string, path: string, method = 'GET', body?: unknown) => proxy(ACCOUNTS[a], GMAIL + path, method, body);
async function slack(method: string) {
  const d = await proxy(SLACK, 'https://slack.com/api/' + method);
  if (!d.ok) throw new Error('Slack ' + method.split('?')[0] + ': ' + (d.error || ''));
  return d;
}

const header = (m: any, n: string) => String(((m.payload && m.payload.headers) || []).find((h: any) => String(h.name).toLowerCase() === n.toLowerCase())?.value || '');
function addr(s: string) {
  const m = String(s || '').match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  if (m) return { name: m[1].trim() || m[2].trim(), email: m[2].trim().toLowerCase() };
  const e = String(s || '').trim().toLowerCase(); return { name: e, email: e };
}
function b64(s: string) { try { const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/')); return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))); } catch { return ''; } }
function body(msg: any) {
  const f = { plain: '', html: '' };
  (function walk(p: any) { if (!p) return; if (p.body && p.body.data) { const t = b64(p.body.data); if (p.mimeType === 'text/plain' && !f.plain) f.plain = t; if (p.mimeType === 'text/html' && !f.html) f.html = t; } (p.parts || []).forEach(walk); })(msg.payload);
  let t = f.plain || f.html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  const cut = t.search(/\n\s*On .{5,120} wrote:\s*\n|\n-{2,}\s*Original Message|\n\s*From: .+\n\s*Sent: /i);
  if (cut > 0) t = t.slice(0, cut);
  return t.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
const unhtml = (s: string) => String(s || '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const rowId = (a: string, t: string) => a + ':' + t;
const threadOf = (id: string) => String(id).replace(/^chase:/, '').replace(/^[a-z]+:/, '');
const me: Record<string, string> = {};
async function myAddress(a: string) { if (!me[a]) me[a] = String((await gmail(a, 'profile')).emailAddress || '').toLowerCase(); return me[a]; }
const gurl = async (a: string, box: string, t: string) => 'https://mail.google.com/mail/?authuser=' + encodeURIComponent(await myAddress(a)) + '#' + box + '/' + t;

async function voice(a: string, to: string) {
  if (!to || ROBOT.test(to)) return '';
  const l = await gmail(a, 'messages?maxResults=3&q=' + encodeURIComponent('in:sent to:' + to));
  const out: string[] = [];
  for (const m of l.messages || []) out.push(body(await gmail(a, 'messages/' + m.id + '?format=full')).slice(0, 700));
  return out.filter(Boolean).join('\n---\n');
}

/** Same as emailPullInbox_: every unread inbox email; read or archived in Gmail since -> off the list. */
async function pullInbox(a: string) {
  const threads: any[] = []; let page = '';
  for (let pg = 0; pg < 4; pg++) {
    const l = await gmail(a, 'threads?maxResults=100&q=' + encodeURIComponent('in:inbox is:unread') + (page ? '&pageToken=' + page : ''));
    threads.push(...(l.threads || [])); page = l.nextPageToken || ''; if (!page) break;
  }
  const ids = threads.map((t) => rowId(a, t.id));
  const hist: Record<string, string> = {}; threads.forEach((t) => hist[rowId(a, t.id)] = String(t.historyId || ''));
  let added = 0;
  if (ids.length) {
    const have: Record<string, boolean> = {}, stale: string[] = [];
    for (const r of await q('SELECT id, msg_id, history_id FROM inbox_emails WHERE id IN (' + ids.map(lit).join(',') + ')')) {
      have[r.id] = true;
      if (!hist[r.id] || r.history_id === hist[r.id]) continue;
      const th = await gmail(a, 'threads/' + threadOf(r.id) + '?format=metadata&metadataHeaders=Message-ID');
      const ms = (th.messages || []).filter((m: any) => (m.labelIds || []).indexOf('DRAFT') < 0 && !/reacted via Gmail/i.test(String(m.snippet || '')));
      if (ms.length && header(ms[ms.length - 1], 'Message-ID') !== r.msg_id) { stale.push(r.id); delete have[r.id]; continue; }
      await x('UPDATE inbox_emails SET history_id = ' + lit(hist[r.id]) + ' WHERE id = ' + lit(r.id));
    }
    if (stale.length) await x('DELETE FROM inbox_emails WHERE id IN (' + stale.map(lit).join(',') + ')');
    for (const id of ids) {
      if (have[id]) continue;
      const th = await gmail(a, 'threads/' + threadOf(id) + '?format=full');
      const ms = (th.messages || []).filter((m: any) => (m.labelIds || []).indexOf('DRAFT') < 0 && !/reacted via Gmail/i.test(String(m.snippet || '')));
      if (!ms.length) continue;
      const last = ms[ms.length - 1], from = addr(header(last, 'From')), to = addr(header(last, 'To')).email;
      const text = ms.slice(-3).map((m: any) => 'From: ' + header(m, 'From') + '\nDate: ' + header(m, 'Date') + '\n\n' + body(m).slice(0, 1500)).join('\n\n=====\n\n');
      const mine = OWN.test(from.email) && !OWN.test(to);
      let v = ''; try { v = await voice(a, from.email); } catch { v = ''; }
      await x('INSERT INTO inbox_emails (id, account, kind, from_name, from_email, to_email, subject, snippet, thread_text, voice_examples, received_at, gmail_url, msg_id, history_id) VALUES ('
        + [id, a, 'in', from.name, from.email, to, header(last, 'Subject') || '(no subject)', unhtml(last.snippet), text, v].map(lit).join(', ')
        + ', to_timestamp(' + Math.floor(Number(last.internalDate) / 1000) + '), ' + lit(await gurl(a, 'inbox', threadOf(id))) + ', ' + lit(header(last, 'Message-ID')) + ', ' + lit(String(th.historyId || '')) + ') ON CONFLICT (id) DO NOTHING');
      if (mine) await x("UPDATE inbox_emails SET category = 'chase', why = 'You wrote last, waiting on them', sorted_at = now() WHERE id = " + lit(id));
      added++;
    }
    // Marked unread again in Gmail: back on the list ('gone' ones too would be wrong: Done with stays done).
    await x("UPDATE inbox_emails SET status = 'open', gmail_done = false, done_at = NULL WHERE status IN ('done', 'to_claude') AND gmail_done AND done_at < now() - interval '10 minutes' AND id IN (" + ids.map(lit).join(',') + ')');
    await x('UPDATE inbox_emails SET seen_at = now() WHERE id IN (' + ids.map(lit).join(',') + ')');
  }
  await x("UPDATE inbox_emails SET status = 'done', gmail_done = true, done_at = now() WHERE kind = 'in' AND status = 'open' AND account = " + lit(a) + (ids.length ? ' AND id NOT IN (' + ids.map(lit).join(',') + ')' : ''));
  return { unread: ids.length, added };
}

/** Done on the page: read in Gmail (never archived). */
async function applyDone(a: string) {
  const rows = await q("SELECT id FROM inbox_emails WHERE kind = 'in' AND account = " + lit(a) + " AND status IN ('done', 'to_claude', 'gone') AND NOT gmail_done LIMIT 50");
  for (const r of rows) {
    try { await gmail(a, 'threads/' + threadOf(r.id) + '/modify', 'POST', { removeLabelIds: ['UNREAD'] }); } catch (e) { if (!/ 404/.test(String(e))) throw e; }
    await x('UPDATE inbox_emails SET gmail_done = true WHERE id = ' + lit(r.id));
  }
  return rows.length;
}

/** Same as emailPullChases_: Owen wrote last 3 to 14 days ago, to a person. Threads only refetched when Gmail says they changed. */
async function pullChases(a: string, seen: Record<string, string>) {
  const mine = await myAddress(a), open: string[] = [];
  const l = await gmail(a, 'threads?maxResults=40&q=' + encodeURIComponent('in:sent newer_than:14d older_than:3d'));
  for (const t of l.threads || []) {
    const k = a + '_' + t.id, s = seen[k];
    if (s && s.split('|')[0] === String(t.historyId)) { if (s.split('|')[1]) open.push(s.split('|')[1]); continue; }
    seen[k] = String(t.historyId) + '|';
    const th = await gmail(a, 'threads/' + t.id + '?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Message-ID&metadataHeaders=Date');
    const ms = (th.messages || []).filter((m: any) => (m.labelIds || []).indexOf('DRAFT') < 0 && !/reacted via Gmail/i.test(String(m.snippet || '')));
    if (!ms.length) continue;
    const last = ms[ms.length - 1];
    if (addr(header(last, 'From')).email !== mine) continue;
    const to = addr(header(last, 'To'));
    if (!to.email || to.email === mine || ROBOT.test(to.email) || OWN.test(to.email)) continue;
    const subj = header(last, 'Subject');
    if (/^fwd?:/i.test(subj) || /reacted via Gmail/i.test(String(last.snippet || '')) || /^tez@|@tez\./i.test(to.email)) continue;
    const id = 'chase:' + rowId(a, t.id);
    open.push(id); seen[k] = String(t.historyId) + '|' + id;
    const text = ms.slice(-3).map((m: any) => 'From: ' + header(m, 'From') + '\nDate: ' + header(m, 'Date') + '\n\n' + String(m.snippet || '')).join('\n\n=====\n\n');
    await x("INSERT INTO inbox_emails (id, account, kind, category, from_name, from_email, to_email, subject, snippet, thread_text, received_at, gmail_url, msg_id, sorted_at) VALUES ("
      + [id, a, 'chase', 'chase', to.name, to.email, to.email, subj || '(no subject)', unhtml(last.snippet), text].map(lit).join(', ')
      + ', to_timestamp(' + Math.floor(Number(last.internalDate) / 1000) + '), ' + lit(await gurl(a, 'sent', t.id)) + ', ' + lit(header(last, 'Message-ID')) + ', now()) ON CONFLICT (id) DO UPDATE SET seen_at = now()');
  }
  await x("UPDATE inbox_emails SET status = 'done', done_at = now() WHERE kind = 'chase' AND status = 'open' AND account = " + lit(a) + (open.length ? ' AND id NOT IN (' + open.map(lit).join(',') + ')' : ''));
  return open.length;
}

/** Same as slackPull_: people only. DMs where a person wrote last; @mentions by people. Closes what Owen answered or read in Slack. */
async function pullSlack(state: any) {
  if (!state.people || Date.now() - (state.peopleAt || 0) > 6 * 3600e3) {
    const auth = await slack('auth.test'), ppl: any = {};
    for (const u of (await slack('users.list?limit=300')).members || []) if (!u.deleted && !u.is_bot && u.id !== 'USLACKBOT') ppl[u.id] = (u.profile && (u.profile.display_name || u.profile.real_name)) || u.real_name || u.name;
    state.people = ppl; state.me = auth.user_id; state.team = String(auth.url || '').replace(/\/$/, ''); state.peopleAt = Date.now();
  }
  const people = state.people, meId = state.me, team = state.team || 'https://slack.com';
  const since = Math.floor(Date.now() / 1000) - 7 * 86400, open: string[] = [];
  const known: Record<string, number> = {};
  for (const r of await q("SELECT id, extract(epoch FROM received_at)::bigint AS ts FROM inbox_emails WHERE account = 'slack'")) known[r.id] = Number(r.ts);
  const names = (t: string) => String(t || '').replace(/<@(U[A-Z0-9]+)(\|[^>]*)?>/g, (_: string, u: string) => '@' + (u === meId ? 'Owen' : people[u] || 'someone'));
  const put = async (id: string, ch: string, msgs: any[], last: any, url?: string) => {
    open.push(id);
    if (known[id] === Math.floor(Number(last.ts))) return;
    const text = msgs.slice(-8).map((m) => (people[m.user] || 'Someone') + ': ' + (m.text || '')).join('\n\n'), line = names(last.text);
    await x("INSERT INTO inbox_emails (id, account, kind, from_name, from_email, subject, snippet, thread_text, received_at, gmail_url) VALUES ("
      + [id, 'slack', 'in', people[last.user] || 'Someone', 'slack:' + last.user, line.replace(/\s+/g, ' ').slice(0, 120) || '(message)', line.slice(0, 300), text].map(lit).join(', ')
      + ', to_timestamp(' + Math.floor(Number(last.ts)) + '), ' + lit(url || team + '/archives/' + ch + '/p' + String(last.ts).replace('.', '')) + ')'
      + " ON CONFLICT (id) DO UPDATE SET subject = EXCLUDED.subject, snippet = EXCLUDED.snippet, thread_text = EXCLUDED.thread_text, received_at = EXCLUDED.received_at, gmail_url = EXCLUDED.gmail_url,"
      + " status = CASE WHEN inbox_emails.received_at < EXCLUDED.received_at THEN 'open' ELSE inbox_emails.status END, category = CASE WHEN inbox_emails.received_at < EXCLUDED.received_at THEN NULL ELSE inbox_emails.category END, seen_at = now()");
  };
  for (const c of (await slack('conversations.list?types=im,mpim&limit=100&exclude_archived=true')).channels || []) {
    if (c.is_im && !people[c.user]) continue;
    const h = await slack('conversations.history?channel=' + c.id + '&limit=30');
    const msgs = (h.messages || []).filter((m: any) => Number(m.ts) >= since && !m.subtype && (people[m.user] || m.user === meId)).reverse();
    if (!msgs.length || msgs[msgs.length - 1].user === meId) continue;
    await put('slack:' + c.id, c.id, msgs, msgs[msgs.length - 1]);
  }
  const day = new Date(since * 1000).toISOString().slice(0, 10);
  for (const m of ((await slack('search.messages?count=40&sort=timestamp&query=' + encodeURIComponent('<@' + meId + '> after:' + day))).messages || {}).matches || []) {
    if (!people[m.user] || m.user === meId || !m.channel || m.channel.is_im || m.channel.is_mpim) continue;
    // The permalink carries thread_ts when the mention is a reply in a thread; the page opens that thread.
    await put('slack:' + m.channel.id + ':' + m.ts, m.channel.id, [m], m, m.permalink);
  }
  await x("UPDATE inbox_emails SET status = 'done', done_at = now() WHERE account = 'slack' AND status = 'open' AND id NOT LIKE 'slack:%:%'" + (open.length ? ' AND id NOT IN (' + open.map(lit).join(',') + ')' : ''));
  // Read in Slack since it came in.
  const read: Record<string, number> = {}, shut: string[] = [];
  for (const r of await q("SELECT id, extract(epoch FROM received_at)::bigint AS ts FROM inbox_emails WHERE account = 'slack' AND status = 'open'")) {
    const sp = String(r.id).split(':'), ch = sp[1], ts = Number(sp[2] || r.ts);
    try { if (!(ch in read)) read[ch] = Number((await slack('conversations.info?channel=' + ch)).channel.last_read || 0); } catch { read[ch] = 0; }
    if (read[ch] && read[ch] >= ts) shut.push(r.id);
  }
  if (shut.length) await x("UPDATE inbox_emails SET status = 'done', done_at = now() WHERE status = 'open' AND id IN (" + shut.map(lit).join(',') + ')');
  return open.length - shut.length;
}

Deno.serve(async (req) => {
  // Only the service key may run this (Supabase has already checked the signature; anon keys are refused here).
  let role = '';
  try { role = JSON.parse(atob(String(req.headers.get('Authorization') || '').split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role; } catch { role = ''; }
  if (role !== 'service_role') return new Response('no', { status: 401 });
  const t0 = Date.now(), out: any = { inbox: {}, done: {}, chases: {} }, errors: string[] = [];
  const st = ((await q("SELECT value FROM app_settings WHERE key = 'inbox_edge_state'"))[0] || {}).value || {};
  COMPOSIO = ((await q("SELECT decrypted_secret AS s FROM vault.decrypted_secrets WHERE name = 'composio_api_key'"))[0] || {}).s || '';
  await Promise.all(Object.keys(ACCOUNTS).map(async (a) => {
    try { out.done[a] = await applyDone(a); } catch (e) { errors.push(a + ' done: ' + e); }
    try { out.inbox[a] = await pullInbox(a); } catch (e) { errors.push(a + ' inbox: ' + e); }
  }));
  // Chases every half hour, Slack every 6 minutes: they change slowly and cost the most calls.
  if (Date.now() - (st.chasesAt || 0) > 30 * 60e3) {
    st.seen = st.seen || {};
    const before = errors.length;
    await Promise.all(Object.keys(ACCOUNTS).map(async (a) => { try { out.chases[a] = await pullChases(a, st.seen); } catch (e) { errors.push(a + ' chases: ' + e); } }));
    if (errors.length === before) st.chasesAt = Date.now();
  }
  if (Date.now() - (st.slackAt || 0) > 5.5 * 60e3) {
    try { out.slack = await pullSlack(st); st.slackAt = Date.now(); } catch (e) { errors.push('slack: ' + e); }
  }
  await x("INSERT INTO app_settings (key, value) VALUES ('inbox_edge_state', " + lit(JSON.stringify(st)) + "::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  const last = { at: new Date().toISOString(), ms: Date.now() - t0, out, errors };
  await x("INSERT INTO app_settings (key, value) VALUES ('inbox_edge_last', " + lit(JSON.stringify(last)) + "::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value");
  return new Response(JSON.stringify(last), { headers: { 'Content-Type': 'application/json' } });
});
