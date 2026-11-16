import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 't', version: '1' });
await c.connect(new StdioClientTransport({ command: 'node', args: [new URL('./server.js', import.meta.url).pathname] }));
console.log((await c.listTools()).tools.map(t => t.name).join(', '));
const calls = [
 ['whatsapp_chats', { limit: 3, people_only: true }],
 ['whatsapp_history', { chat: 'Laura', limit: 3 }],
 ['whatsapp_search', { query: 'gig', limit: 2 }],
 ['inbox_piles', { limit: 2 }],
 ['tasks', {}],
 ['search_notes', { query: 'TEZ', limit: 1 }],
 ['search_email', { query: 'invoice', account: 'tez', limit: 1 }],
];
for (const [n, a] of calls) { const r = await c.callTool({ name: n, arguments: a }); const t = r.content[0].text; console.log('==', n, r.isError ? 'ERROR' : 'ok', t.length, 'chars'); console.log(t.slice(0, 350).replace(/\n/g,' ')); }
const em = JSON.parse((await c.callTool({ name: 'search_email', arguments: { query: 'invoice', account: 'tez', limit: 1 } })).content[0].text);
const th = em.threads[0]; const r = await c.callTool({ name: 'read_email_thread', arguments: { account: th.account, thread_id: th.thread_id } });
console.log('== read_email_thread', r.isError ? 'ERROR' : 'ok', r.content[0].text.slice(0, 200).replace(/\n/g,' '));
await c.close();
