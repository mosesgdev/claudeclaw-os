#!/usr/bin/env bash
# Boot wrapper for com.claudeclaw.main. Sources .env into the process
# environment, then execs the Node entrypoint. Keeps secret handling
# out of the plist's EnvironmentVariables dict.
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f .env ]; then
  echo "launchd-start: .env missing at $(pwd)/.env" >&2
  exit 1
fi
set -a
. ./.env
set +a
exec /Users/moses/.local/bin/node dist/index.js
