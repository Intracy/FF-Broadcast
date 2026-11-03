#!/bin/bash
# Richtet FF Rundown auf dem Mac als Hintergrunddienst ein (startet automatisch bei der Anmeldung).
# Entfernen:  ./install-mac-autostart.sh --remove
set -e
cd "$(dirname "$0")"
APP_DIR="$(pwd)"
LABEL="de.frankenfinals.rundown"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PORT="${PORT:-3000}"

if [ "$1" = "--remove" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Autostart entfernt."; exit 0
fi

NODE="$(PATH="/opt/homebrew/bin:/usr/local/bin:$PATH" command -v node || true)"
[ -z "$NODE" ] && { echo "Node.js nicht gefunden – bitte Node.js 22 LTS installieren (https://nodejs.org)."; exit 1; }
"$NODE" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)" || { echo "Node.js $("$NODE" -v) ist zu alt (mind. 22.13)."; exit 1; }

mkdir -p "$HOME/Library/LaunchAgents" "$APP_DIR/data"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>--no-warnings</string><string>$APP_DIR/server/index.js</string></array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>EnvironmentVariables</key><dict>
    <key>PORT</key><string>$PORT</string>
    <key>DATA_DIR</key><string>$APP_DIR/data</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$APP_DIR/data/server.log</string>
  <key>StandardErrorPath</key><string>$APP_DIR/data/server.log</string>
</dict></plist>
PL
launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo "FF Rundown läuft jetzt im Hintergrund und startet automatisch: http://localhost:$PORT"
echo "Log: $APP_DIR/data/server.log   ·   Entfernen: ./install-mac-autostart.sh --remove"
