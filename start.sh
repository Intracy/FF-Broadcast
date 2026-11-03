#!/usr/bin/env sh
# Start auf Linux / Raspberry Pi / macOS (Terminal)
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then echo "Node.js nicht gefunden – bitte Node.js 22 LTS installieren (https://nodejs.org)"; exit 1; fi
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" || { echo "Node.js $(node -v) ist zu alt – mindestens 22.13 nötig."; exit 1; }
# Exit-Code 75 = Neustart angefordert (z. B. nach Wiederherstellung eines Backups)
while :; do
  node --no-warnings server/index.js
  code=$?
  [ "$code" -eq 75 ] || exit "$code"
  echo "Neustart …"
done
