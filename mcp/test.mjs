// Runs every tool once against live data: node test.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const c = new Client({ name: 't', version: '1' });
await c.connect(new StdioClientTransport({ command: 'node', args: [new URL('./server.js', import.meta.url).pathname], stderr: 'ignore' }));
console.log((await c.listTools()).tools.map(t => t.name).join(', '));
const calls = [
 ['whatsapp_chats', { limit: 3, sort: 'most_messages' }],
 ['whatsapp_history', { chat: 'Laura', from: '2015-01-01', limit: 3 }],
 ['whatsapp_history', { chat: 'Joe', limit: 4 }],
 ['whatsapp_search', { query: 'gig', limit: 2, context: 1 }],
 ['person', { name: 'Sonia', recent: 3 }],
 ['search_everything', { query: 'Kahuna' }],
 ['inbox_piles', { limit: 2, account: 'slack', include_closed: true }],
 ['tasks', {}],
 ['search_notes', { query: 'TEZ', limit: 1 }],
 ['search_email', { query: 'invoice', account: 'tez', limit: 1 }],
];
for (const [n, a] of calls) { const t0 = Date.now(); const r = await c.callTool({ name: n, arguments: a }); const t = r.content[0].text; console.log('==', n, JSON.stringify(a), r.isError ? 'ERROR' : 'ok', t.length, 'chars', Date.now() - t0, 'ms'); console.log(t.slice(0, 500).replace(/\s+/g,' ')); }
await c.close();
