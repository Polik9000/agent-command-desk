#!/bin/sh
# Spustí Agent Command Desk (macOS/Linux): backend v Node.js na pozadí; backend sám otevře okno Chrome --app.
set -eu

REPO=$(cd "$(dirname "$0")/.." && pwd)
SERVER="$REPO/src/server/server.mjs"

NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "Node.js (node) nenalezen v PATH." >&2; exit 1; }

# Název a složka stavu z local/config.json (zároveň ověří konfiguraci).
if ! NAME=$("$NODE" "$SERVER" --info name 2>&1); then
  echo "Konfigurace není v pořádku:" >&2; echo "$NAME" >&2; exit 1
fi
STATE=$("$NODE" "$SERVER" --info stateDir)
LOGS="$STATE/logs"
mkdir -p "$LOGS"

# Už běží? (proces node se server.mjs z tohoto repa)
if pgrep -f "$SERVER\$" >/dev/null 2>&1; then
  echo "$NAME už běží – okno najdete v Docku."; exit 0
fi
rm -f "$STATE/server.pid"

# Staré logy: ponechat posledních 20 souborů.
ls -1t "$LOGS"/server-*.log 2>/dev/null | tail -n +21 | while IFS= read -r f; do rm -f "$f"; done

TS=$(date +%Y%m%d-%H%M%S)
OUT="$LOGS/server-$TS.log"
ERR="$LOGS/server-$TS.err.log"
(cd "$REPO/src/server" && nohup "$NODE" "$SERVER" >"$OUT" 2>"$ERR" </dev/null &)

sleep 2
if ! pgrep -f "$SERVER\$" >/dev/null 2>&1; then
  if grep -q "už běží" "$ERR" 2>/dev/null; then echo "$NAME už běží."; exit 0; fi
  echo "$NAME se nespustil. Log: $ERR" >&2
  tail -n 20 "$ERR" >&2 || true
  exit 1
fi
echo "$NAME běží – otevírám okno."
