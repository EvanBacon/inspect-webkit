#!/usr/bin/env bash
# Block until the CDP bridge on $1 (default 9222) is serving /json/version.
# Times out after 5s. Used in place of `sleep N` after backgrounding the bridge.
set -euo pipefail
PORT="${1:-9222}"
for _ in $(seq 1 50); do
  if curl -fsS "http://localhost:${PORT}/json/version" >/dev/null 2>&1; then
    exit 0
  fi
  sleep 0.1
done
echo "wait-ready: bridge on :${PORT} did not respond within 5s" >&2
exit 1
