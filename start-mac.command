#!/bin/bash
# FF Rundown – Start auf dem Mac (Doppelklick im Finder)
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js wurde nicht gefunden."
  echo "Bitte Node.js 22 LTS installieren: https://nodejs.org  (oder: brew install node@22)"
  read -n 1 -s -r -p "Taste drücken zum Schließen …"; exit 1
fi
if ! node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; then
  echo "Node.js $(node -v) ist zu alt – benötigt wird mindestens 22.13. Bitte aktualisieren: https://nodejs.org"
  read -n 1 -s -r -p "Taste drücken zum Schließen …"; exit 1
fi

export PORT="${PORT:-3000}"
echo "Starte FF Rundown auf Port $PORT … (Fenster offen lassen, Beenden mit Ctrl+C)"
( sleep 2; open "http://localhost:$PORT" ) &
exec node --no-warnings server/index.js
