#!/bin/sh
# Odinstaluje Agent Command Desk (macOS/Linux): spouštěč ~/.local/bin/<app.id> a složku stavu (logy, profil Chrome).
# Složky účtů Claude Code, přihlášení ani repozitář nemění.
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
SERVER="$REPO/src/server/server.mjs"
NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "Node.js (node) nenalezen v PATH." >&2; exit 1; }
if ! ID=$("$NODE" "$SERVER" --info id 2>&1); then
  echo "Konfigurace není v pořádku:" >&2; echo "$ID" >&2; exit 1
fi
STATE=$("$NODE" "$SERVER" --info stateDir)

# Běžící server dostane SIGTERM a sám ukončí běhy claude.
if pkill -f "$SERVER\$" 2>/dev/null; then echo "Ukončuji běžící server…"; sleep 2; fi

[ -f "$HOME/.local/bin/$ID" ] && rm -f "$HOME/.local/bin/$ID" && echo "Smazáno: $HOME/.local/bin/$ID"
[ -d "$STATE" ] && rm -rf "$STATE" && echo "Smazáno: $STATE"
echo "Hotovo. Složku repozitáře (včetně local/) smažte ručně, pokud ji nechcete."
