"""Hands emails Owen sent from the Inbox page to his Claude chats.

Run by the Claude scheduled task "Inbox to chats" on Owen's Mac (it has the
tool that writes into a chat; this script only reads and marks the queue).
Uses Moon's database helper (~/moon-dashboard/tools/snippets/moon.py), so no
keys live here.

  relay.py pending            -> JSON list of messages waiting [{id, session_id, session_title, message}]
  relay.py done <id> <result> -> marks one delivered (result: delivered / queued / error text)
  relay.py chats <json>       -> saves Owen's chat list for the page's picker
"""
import json, os, sys
sys.path.insert(0, os.path.expanduser('~/moon-dashboard/tools/snippets'))
from moon import q, x

def esc(s):
    return str(s).replace("'", "''")

cmd = sys.argv[1] if len(sys.argv) > 1 else ''
if cmd == 'pending':
    rows = q("SELECT id, session_id, session_title, message FROM inbox_chat_queue WHERE delivered_at IS NULL AND created_at > now() - interval '2 days' ORDER BY id LIMIT 20") or []
    print(json.dumps(rows))
elif cmd == 'done':
    x("UPDATE inbox_chat_queue SET delivered_at = now(), result = '%s' WHERE id = %d" % (esc(' '.join(sys.argv[3:])[:300]), int(sys.argv[2])))
    print('ok')
elif cmd == 'chats':
    chats = json.loads(sys.argv[2])
    keep = [{'id': c['sessionId'], 'title': c.get('title') or '', 'at': c.get('lastActivityAt')} for c in chats if not c.get('isArchived')][:40]
    x("INSERT INTO app_settings (key, value) VALUES ('inbox_chats', '%s'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value" % esc(json.dumps({'at': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat(), 'chats': keep})))
    print('ok', len(keep))
else:
    print(__doc__)
