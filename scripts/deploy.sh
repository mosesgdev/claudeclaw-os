#!/usr/bin/env bash
# Idempotent redeploy: clean install, rebuild, restart the launchd service.
# Safe to run after every `git pull` / merge.
set -euo pipefail
cd "$(dirname "$0")/.."
npm ci
npm run build
launchctl kickstart -k "gui/$(id -u)/com.claudeclaw.main"
echo "deploy: service kicked. Tail /tmp/claudeclaw-main.err.log if anything looks off."
