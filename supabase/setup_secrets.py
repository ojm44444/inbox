"""One-off, run by Owen: puts the two keys the inbox-sync function needs into Supabase's encrypted vault.
Reads them from this Mac's Moon config; prints nothing secret."""
import sys, os
sys.path.insert(0, os.path.expanduser('~/moon-dashboard/tools/snippets'))
import moon
have = {r['name'] for r in moon.q("select name from vault.secrets")}
for name, val in (('composio_api_key', moon.CFG['composio_key']), ('inbox_sync_key', moon.KEY)):
    if name not in have:
        moon.x("select vault.create_secret(%s, %s)" % (moon.esc(val), moon.esc(name)))
print('Vault now has:', sorted(r['name'] for r in moon.q("select name from vault.secrets")))
