#!/bin/bash
# Keeps the WhatsApp link running on this Mac (starts at login, restarts if it stops).
set -e
cat > ~/Library/LaunchAgents/com.owen.inbox-whatsapp.plist <<'PL'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.owen.inbox-whatsapp</string>
  <key>ProgramArguments</key><array><string>/usr/local/bin/node</string><string>/Users/owenmellett/Projects/inbox/whatsapp/bridge.js</string></array>
  <key>WorkingDirectory</key><string>/Users/owenmellett/Projects/inbox/whatsapp</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>StandardOutPath</key><string>/tmp/inbox-whatsapp.log</string>
  <key>StandardErrorPath</key><string>/tmp/inbox-whatsapp.log</string>
</dict></plist>
PL
pkill -f "inbox/whatsapp/bridge.js" || true
launchctl unload ~/Library/LaunchAgents/com.owen.inbox-whatsapp.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.owen.inbox-whatsapp.plist
echo "WhatsApp link is running. Open the Inbox > WhatsApp."
