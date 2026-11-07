#!/bin/bash
# One time: lets your Mac save the pictures on your Claude Board cards (Trello won't hand them to the Inbox server).
# Your key and token stay in ~/.moon-snippets/trello.json on this Mac only (readable by you only). Nothing is shown on screen.
read -p "Trello API key: " KEY
read -s -p "Trello token (hidden): " TOKEN; echo
printf '{"key":"%s","token":"%s"}' "$KEY" "$TOKEN" > ~/.moon-snippets/trello.json
chmod 600 ~/.moon-snippets/trello.json
echo "Saved. Pictures start saving within 5 minutes."
