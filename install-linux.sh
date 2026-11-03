#!/bin/bash
# Installation als Dienst auf Linux – Raspberry Pi OS, Debian, Ubuntu (x86 & ARM).
#   sudo ./install-linux.sh            installieren / aktualisieren
#   sudo ./install-linux.sh --remove   Dienst entfernen (Daten bleiben erhalten)
set -e
[ "$(id -u)" -ne 0 ] && { echo "Bitte mit sudo ausführen: sudo ./install-linux.sh"; exit 1; }
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST=/opt/ff-rundown
PORT="${PORT:-3000}"

if [ "$1" = "--remove" ]; then
  systemctl disable --now ff-rundown 2>/dev/null || true
  rm -f /etc/systemd/system/ff-rundown.service; systemctl daemon-reload
  echo "Dienst entfernt. Daten liegen weiterhin in $DEST/data"; exit 0
fi

node_ok() { command -v node >/dev/null 2>&1 && node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"; }
if ! node_ok; then
  echo "Node.js 22 wird installiert (NodeSource) …"
  apt-get update -y && apt-get install -y curl ca-certificates
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node_ok || { echo "Node.js ≥ 22.13 konnte nicht installiert werden. Bitte manuell installieren: https://nodejs.org"; exit 1; }

id rundown >/dev/null 2>&1 || useradd -r -s /usr/sbin/nologin -d "$DEST" rundown
mkdir -p "$DEST/data"
if [ "$SRC" != "$DEST" ]; then
  rm -rf "$DEST/server" "$DEST/shared" "$DEST/public"
  cp -r "$SRC/server" "$SRC/shared" "$SRC/public" "$SRC/package.json" "$DEST/"
fi
chown -R rundown:rundown "$DEST"
chmod 700 "$DEST/data"

cat > /etc/systemd/system/ff-rundown.service <<UNIT
[Unit]
Description=FF Rundown
After=network-online.target
Wants=network-online.target

[Service]
User=rundown
WorkingDirectory=$DEST
Environment=PORT=$PORT
Environment=DATA_DIR=$DEST/data
Environment=TZ=Europe/Berlin
ExecStart=$(command -v node) --no-warnings server/index.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable ff-rundown >/dev/null
systemctl restart ff-rundown
sleep 1
IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo ""
echo "FF Rundown läuft:  http://${IP:-localhost}:$PORT"
echo "Status:  systemctl status ff-rundown   ·   Log:  journalctl -u ff-rundown -f"
