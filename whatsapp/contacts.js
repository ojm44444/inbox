// Names for WhatsApp numbers from Owen's Mac Contacts (WhatsApp doesn't share address-book names with linked devices).
// Read only. Writes ~/.moon-snippets/wa-contacts.json: { "447700900123": "Name" }.
const { execFileSync, execFile } = require('child_process'), fs = require('fs'), path = require('path'), os = require('os');
const OUT = path.join(os.homedir(), '.moon-snippets/wa-contacts.json');
function norm(p) { let d = String(p).replace(/[^0-9+]/g, ''); if (d.startsWith('+')) d = d.slice(1); else if (d.startsWith('00')) d = d.slice(2); else if (d.startsWith('0')) d = '44' + d.slice(1); return d.length >= 8 ? d : ''; }
function exportContacts() {
  const js = "var C=Application('Contacts');JSON.stringify({n:C.people.name(),p:C.people.phones.value()})";
  const r = JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', js], { timeout: 120000 }).toString());
  const map = {};
  r.n.forEach((name, i) => (r.p[i] || []).forEach((ph) => { const k = norm(ph); if (k && name) map[k] = name; }));
  fs.writeFileSync(OUT, JSON.stringify(map));
  return Object.keys(map).length;
}
// Same, without holding anything up (macOS may ask once for Contacts access).
function exportContactsAsync(done) {
  const js = "var C=Application('Contacts');JSON.stringify({n:C.people.name(),p:C.people.phones.value()})";
  execFile('osascript', ['-l', 'JavaScript', '-e', js], { timeout: 90000 }, (err, stdout) => {
    if (err) return done && done(err);
    try { const r = JSON.parse(stdout), map = {}; r.n.forEach((name, i) => (r.p[i] || []).forEach((ph) => { const k = norm(ph); if (k && name) map[k] = name; })); fs.writeFileSync(OUT, JSON.stringify(map)); done && done(null, Object.keys(map).length); } catch (e) { done && done(e); }
  });
}
module.exports = { exportContacts, exportContactsAsync, OUT };
if (require.main === module) console.log(exportContacts(), 'numbers');
