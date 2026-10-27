#!/bin/bash
# Mac one-click setup wrapper - double-click me (or run: node setup.mjs)
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "[ERROR] Node.js not found. Install it first: brew install node  (or download from https://nodejs.org)"
  read -r -p "Press Enter to close..." _
  exit 1
fi
node setup.mjs
echo ""
read -r -p "Press Enter to close..." _
