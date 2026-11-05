"""Owen's Apple Notes and Reminders into the Inbox (they only live on his Mac).

Run by launchd every minute with Moon's snippets venv Python (~/Library/LaunchAgents/com.owen.inbox-macsync.plist).
Every minute: carries out what Owen did on the page (inbox_mac_actions: tick a reminder,
add one, open a note) and re-reads open reminders, so one ticked on his phone leaves the
page within a minute. Every 15 minutes: the 40 most recent notes. Writes only on change. Uses Moon's database helper, so no keys live here.
"""
import datetime, hashlib, json, os, subprocess, sys, time
sys.path.insert(0, os.path.expanduser('~/moon-dashboard/tools/snippets'))
import moon

def _retry(fn, sql):
    # Train and cafe wifi drop connections; try a few times before giving up.
    for i in range(4):
        try: return fn(sql)
        except Exception:
            if i == 3: raise
            time.sleep(2 + i * 3)
def q(sql): return _retry(moon.q, sql)
def x(sql): return _retry(moon.x, sql)
STATE = os.path.expanduser('~/.moon-snippets/inbox_mac_state.json')
state_force_notes = [False]

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
  var att = 0; try { att = x.attachments().length; } catch (e) {}
  out.push({ id: x.id(), title: x.name(), body: String(x.plaintext()).slice(0, 8000), folder: folder, modified: x.modificationDate().toISOString(), attach: att }); }
JSON.stringify(out);
'''
# Reminders through Apple's EventKit (instant), not AppleScript, which times out on a big
# Reminders history. Needs PyObjC (pyobjc-framework-EventKit, in Moon's snippets venv).
import threading
def _store():
    import EventKit
    st = EventKit.EKEventStore.alloc().init(); ev = threading.Event(); res = {}
    def cb(ok, err): res['ok'] = ok; ev.set()
    try: st.requestFullAccessToRemindersWithCompletion_(cb)
    except AttributeError: st.requestAccessToEntityType_completion_(1, cb)
    ev.wait(60)
    if not res.get('ok'): raise RuntimeError('No access to Reminders')
    return st

def read_reminders():
    st = _store(); out = []; ev = threading.Event()
    def got(rs):
        for r in rs or []:
            due = None
            dc = r.dueDateComponents()
            if dc is not None:
                try:
                    import Foundation
                    d = Foundation.NSCalendar.currentCalendar().dateFromComponents_(dc)
                    if d is not None: due = __import__('datetime').datetime.fromtimestamp(d.timeIntervalSince1970(), __import__('datetime').timezone.utc).isoformat()
                except Exception: due = None
            out.append({'id': r.calendarItemIdentifier(), 'title': r.title() or '', 'list': r.calendar().title(), 'due': due, 'body': r.notes() or ''})
        ev.set()
    st.fetchRemindersMatchingPredicate_completion_(st.predicateForIncompleteRemindersWithDueDateStarting_ending_calendars_(None, None, None), got)
    ev.wait(120)
    return out

def complete_reminder(rid):
    st = _store(); r = st.calendarItemWithIdentifier_(rid)
    if r is None: raise RuntimeError('Reminder not found')
    r.setCompleted_(True); ok, err = st.saveReminder_commit_error_(r, True, None)
    if not ok: raise RuntimeError(str(err))

def add_reminder(text, due=''):
    import EventKit, Foundation
    st = _store(); r = EventKit.EKReminder.reminderWithEventStore_(st)
    r.setTitle_(text); r.setCalendar_(st.defaultCalendarForNewReminders())
    if due:
        y, m, d = (int(v) for v in due.split('-'))
        dc = Foundation.NSDateComponents.alloc().init(); dc.setYear_(y); dc.setMonth_(m); dc.setDay_(d)
        r.setDueDateComponents_(dc)
    ok, err = st.saveReminder_commit_error_(r, True, None)
    if not ok: raise RuntimeError(str(err))

def rename_reminder(rid, text):
    st = _store(); r = st.calendarItemWithIdentifier_(rid)
    if r is None: raise RuntimeError('Reminder not found')
    r.setTitle_(text); ok, err = st.saveReminder_commit_error_(r, True, None)
    if not ok: raise RuntimeError(str(err))

def _html(text):
    import html
    return ''.join('<div>%s</div>' % (html.escape(l) if l.strip() else '<br>') for l in text.split('\n'))

# Owen's edit replaces the note's text. Refused when the note changed on the Mac since he
# opened it, or holds pictures or files (plain text would drop them).
EDIT_JS = """
var N = Application('Notes'); var x = N.notes.byId(%s); var a = %s;
var att = 0; try { att = x.attachments().length; } catch (e) {}
if (att) throw new Error('This note has pictures or files, edit it in Notes');
if (a.base && Math.abs(x.modificationDate() - new Date(a.base)) > 1500) throw new Error('Changed on your Mac since, not saved');
x.body = a.html; JSON.stringify({ title: x.name(), modified: x.modificationDate().toISOString() });
"""
NEW_JS = "var N = Application('Notes'); var n = N.Note({ body: %s }); N.defaultAccount().defaultFolder().notes.push(n); JSON.stringify('ok')"

def do_actions():
    for a in q("SELECT id, action, target, text FROM inbox_mac_actions WHERE done_at IS NULL ORDER BY id LIMIT 20") or []:
        if a['action'] in ('edit', 'note'): state_force_notes[0] = True  # reread notes either way, so the page shows what is really there
        try:
            if a['action'] == 'complete':
                complete_reminder(a['target'])
                x("UPDATE inbox_mac SET done = true WHERE id = '%s'" % esc(a['target']))
            elif a['action'] == 'add':
                add_reminder(a['text'], a.get('target') or '')
            elif a['action'] == 'rename':
                rename_reminder(a['target'], a['text'])
            elif a['action'] == 'open':
                osa("var N = Application('Notes'); N.activate(); N.notes.byId(%s).show(); JSON.stringify('ok')" % json.dumps(a['target']), 30)
            elif a['action'] == 'edit':
                e = json.loads(a['text'])
                r = osa(EDIT_JS % (json.dumps(a['target']), json.dumps({'html': _html(e['text']), 'base': e.get('base', '')})), 60)
                x("UPDATE inbox_mac SET title = '%s', modified_at = '%s' WHERE id = '%s'" % (esc(r['title']), esc(r['modified']), esc(a['target'])))
            elif a['action'] == 'note':
                osa(NEW_JS % json.dumps(_html(a['text'])), 60)
            res = 'ok'
        except Exception as e:
            res = 'error: ' + str(e)[:200]
        x("UPDATE inbox_mac_actions SET done_at = now(), result = '%s' WHERE id = %d" % (esc(res), int(a['id'])))

def sync(kind, rows, folder_key):
    """One upsert for all rows, one delete for anything gone from the Mac (deleted, or ticked there)."""
    def lit(v): return ("'%s'" % esc(v)) if v else 'NULL'
    if rows:
        x("INSERT INTO inbox_mac (id, kind, title, body, list, due, modified_at, attach, done, synced_at) VALUES "
          + ','.join("('%s', '%s', '%s', '%s', '%s', %s, %s, %d, false, now())" % (esc(r['id']), kind, esc(r.get('title')), esc(r.get('body')), esc(r.get(folder_key)), lit(r.get('due')), lit(r.get('modified')), int(r.get('attach') or 0)) for r in rows)
          + " ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, body = EXCLUDED.body, list = EXCLUDED.list, due = EXCLUDED.due, modified_at = EXCLUDED.modified_at, attach = EXCLUDED.attach, done = false, synced_at = now()")
    ids = [r['id'] for r in rows]
    x("DELETE FROM inbox_mac WHERE kind = '%s'%s" % (kind, (" AND id NOT IN (%s)" % ','.join("'%s'" % esc(i) for i in ids)) if ids else ''))

def changed(state, kind, rows):
    """Only write when something changed, so the minute runs cost nothing most of the time."""
    h = hashlib.md5(json.dumps(rows, sort_keys=True, default=str).encode()).hexdigest()
    if state.get(kind) == h: return False
    state[kind] = h; return True

if __name__ == '__main__':
    try: state = json.load(open(STATE))
    except Exception: state = {}
    status = {}
    try:
        if q("SELECT 1 AS n FROM inbox_mac_actions WHERE done_at IS NULL LIMIT 1"): do_actions(); state.pop('reminder', None); state.pop('note', None)
    except Exception as e: status['actions_error'] = str(e)[:200]
    try:
        rems = read_reminders(); status['reminders'] = len(rems)
        if changed(state, 'reminder', rems): sync('reminder', rems, 'list')
    except Exception as e: status['reminders_error'] = str(e)[:200]; state.pop('reminder', None)
    if '--notes' in sys.argv or state_force_notes[0] or time.time() - state.get('notes_at', 0) > 14 * 60:
        try:
            notes = [n for n in osa(NOTES_JS, 300) if n.get('folder') != 'Recently Deleted']; status['notes'] = len(notes)
            if changed(state, 'note', notes): sync('note', notes, 'folder')
            state['notes_at'] = time.time()
        except Exception as e: status['notes_error'] = str(e)[:200]; state.pop('note', None)
    # "Synced X ago" on the page: refreshed every 15 minutes, or at once when something failed.
    if 'notes' in status or time.time() - state.get('status_at', 0) > 14 * 60 or any(k.endswith('error') for k in status):
        try:
            x("INSERT INTO app_settings (key, value) VALUES ('inbox_mac_last', '%s'::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value"
              % esc(json.dumps(dict(status, at=datetime.datetime.now(datetime.timezone.utc).isoformat()))))
            state['status_at'] = time.time()
        except Exception as e: status['status_error'] = str(e)[:200]
    json.dump(state, open(STATE, 'w'))
    print(json.dumps(status))
