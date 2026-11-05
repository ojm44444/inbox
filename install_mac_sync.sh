#!/bin/zsh
# Installs the 15-minute Notes + Reminders sync for the inbox.
P=~/Library/LaunchAgents/com.owen.inbox-macsync.plist
mkdir -p ~/Library/LaunchAgents
cat > "$P" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.owen.inbox-macsync</string>
<key>ProgramArguments</key><array><string>$HOME/.moon-snippets/venv/bin/python</string><string>$HOME/Projects/inbox/mac_sync.py</string></array>
<key>StartInterval</key><integer>60</integer>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>/tmp/inbox-macsync.log</string>
<key>StandardErrorPath</key><string>/tmp/inbox-macsync.log</string>
</dict></plist>
EOF
launchctl unload "$P" 2>/dev/null
launchctl load "$P" && echo "Mac sync installed"
