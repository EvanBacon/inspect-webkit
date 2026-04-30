#!/usr/bin/env bash
# Boot a deterministic iOS simulator and open a known URL in Safari, so the
# CDP bridge has something to enumerate. Idempotent.
#
# Usage: scripts/e2e/sim-boot.sh [url]
set -euo pipefail

URL="${1:-https://example.com/}"
DEVICE_NAME="${SIM_DEVICE_NAME:-iPhone 17 Pro}"

# UUID regex helper (BSD grep, no gawk dependency).
udid_re='[0-9A-F]\{8\}-[0-9A-F]\{4\}-[0-9A-F]\{4\}-[0-9A-F]\{4\}-[0-9A-F]\{12\}'

# Selection priority:
#   1. $SIM_UDID — pin to one specific sim (best for parallel agents).
#   2. First already-booted sim.
#   3. First available $DEVICE_NAME — boot it.
if [ -n "${SIM_UDID:-}" ]; then
  UDID="$SIM_UDID"
  STATE="$(xcrun simctl list devices | grep "$UDID" | grep -oE '\((Booted|Shutdown)\)' | head -n1)"
  [ "$STATE" = "(Shutdown)" ] && xcrun simctl boot "$UDID"
else
  UDID="$(xcrun simctl list devices booted | grep -o "$udid_re" | head -n1)"
  if [ -z "$UDID" ]; then
    UDID="$(xcrun simctl list devices available \
      | grep -F "$DEVICE_NAME" \
      | grep -o "$udid_re" \
      | head -n1)"
    [ -z "$UDID" ] && { echo "no '$DEVICE_NAME' sim available"; exit 1; }
    xcrun simctl boot "$UDID"
  fi
fi

echo "sim: $UDID"
open -a Simulator
xcrun simctl openurl "$UDID" "$URL"
echo "opened: $URL"
