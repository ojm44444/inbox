"""Owen's Apple Notes and Reminders into the Inbox (they only live on his Mac).

Run by launchd every 15 minutes (~/Library/LaunchAgents/com.owen.inbox-macsync.plist).
Reads the 40 most recent notes and the open reminders, saves them to Moon's database
(inbox_mac), and carries out what Owen did on the page (inbox_mac_actions: tick a
reminder done, add a reminder). Uses Moon's database helper, so no keys live here.
"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.expanduser('~/moon-dashboard/tools/snippets'))
from moon import q, x

def esc(s):
    return str(s if s is not None else '').replace("'", "''")

def osa(script, timeout=600):
    r = subprocess.run(['osascript', '-l', 'JavaScript', '-e', script], capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip()[:300])
    return json.loads(r.stdout or 'null')

NOTES_JS = '''
var Notes = Application('Notes'); var out = [];
var ns = Notes.notes; var n = Math.min(40, ns.length);
for (var i = 0; i < n; i++) { var x = ns[i];
  var folder = ''; try { folder = x.container().name(); } catch (e) {}
  out.push({ id: x.id(), title: x.name(), body: String(x.plaintext()).slice(0, 1500), folder: folder, modified: x.modificationDate().toISOString() }); }
JSON.stringify(out);
'''
REM_JS = '''
var R = Application('Reminders'); var out = [];
R.lists().forEach(function (l) {
  var rs = l.reminders.whose({ completed: false });
  var ids = rs.id(), names = rs.name(), dues = rs.dueDate(), bodies = rs.body();
  for (var i = 0; i < ids.length; i++) out.push({ id: ids[i], title: names[i], list: l.name(), due: dues[i] ? dues[i].toISOString() : null, body: bodies[i] || '' });
});
JSON.stringify(out);
'''

def do_actions():
    for a in q("SELECT id, action, target, text FROM inbox_mac_actions WHERE done_at IS NULL ORDER BY id LIMIT 20") or []:
        try:
            if a['action'] == 'complete':
                osa("var R=Application('Reminders'); R.reminders.byId(%s).completed = true; 'ok'" % json.dumps(a['target']), 120)
                x("UPDATE inbox_mac SET done = true WHERE id = '%s'" % esc(a['target']))
            elif a['action'] == 'add':
                osa("var R=Application('Reminders'); var l=R.defaultList(); l.reminders.push(R.Reminder({name: %s})); 'ok'" % json.dumps(a['text']), 120)
            res = 'ok'
        except Exception as e:
            res = 'error: ' + str(e)[:200]
        x("UPDATE inbox_mac_actions SET done_at = now(), result = '%s' WHERE id = %d" % (esc(res), int(a['id'])))

def sync(kind, rows, folder_key):
    for r in rows:
        x("INSERT INTO inbox_mac (id, kind, title, body, list, due, modified_at, done, synced_at) VALUES ('%s', '%s', '%s', '%s', '%s', %s, %s, false, now()) "
          "ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, list = EXCLUDED.list, due = EXCLUDED.due, modified_at = EXCLUDED.modified_at, done = false, synced_at = now()"
          % (esc(r['id']), kind, esc(r.get('title')), esc(r.get('body')), esc(r.get(folder_key)),
             ("'%s'" % esc(r['due'])) if r.get('due') else 'NULL', ("'%s'" % esc(r['modified'])) if r.get('modified') else 'NULL'))
    ids = [r['id'] for r in rows]
    # Gone from the Mac (deleted, or a reminder ticked there): gone from the page.
    x("DELETE FROM inbox_mac WHERE kind = '%s'%s" % (kind, (" AND id NOT IN (%s)" % ','.join("'%s'" % esc(i) for i in ids)) if ids else ''))

if __name__ == '__main__':
    status = {}
    try: do_actions()
    except Exception as e: status['actions'] = str(e)[:200]
    try:
        notes = osa(NOTES_JS, 300); sync('note', notes, 'folder'); status['notes'] = len(notes)
    except Exception as e: status['notes_error'] = str(e)[:200]
    try:
        rems = osa(REM_JS, 900); sync('reminder', rems, 'list'); status['reminders'] = len(rems)
    except Exception as e: status['reminders_error'] = str(e)[:200]
    x("INSERT INTO app_settings (key, value) VALUES ('inbox_mac_last', '%s'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
      % esc(json.dumps(dict(status, at=__import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat()))))
    print(json.dumps(status))
