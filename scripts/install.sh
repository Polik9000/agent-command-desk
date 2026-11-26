#!/bin/sh
# Vytvoří spouštěč ~/.local/bin/<app.id> (macOS/Linux). Nic jiného nemění.
set -eu
REPO=$(cd "$(dirname "$0")/.." && pwd)
SERVER="$REPO/src/server/server.mjs"
NODE=$(command -v node || true)
[ -n "$NODE" ] || { echo "Node.js (node) nenalezen v PATH." >&2; exit 1; }
if ! ID=$("$NODE" "$SERVER" --info id 2>&1); then
  echo "Konfigurace není v pořádku:" >&2; echo "$ID" >&2; exit 1
fi

BIN="$HOME/.local/bin"
mkdir -p "$BIN"
cat >"$BIN/$ID" <<SH
#!/bin/sh
# $ID – lokální okno nad Claude Code. Odinstalace: $REPO/scripts/uninstall.sh
exec sh "$REPO/scripts/launch.sh" "\$@"
SH
chmod +x "$BIN/$ID"
echo "Vytvořeno: $BIN/$ID"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Pozor: $BIN není v PATH (přidejte do ~/.zshrc: export PATH=\"\$HOME/.local/bin:\$PATH\")." ;; esac
echo "Spuštění: $ID"
