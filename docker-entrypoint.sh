#!/bin/sh
# Datenordner gehört dem App-Benutzer und ist nur für ihn lesbar – danach ohne Root-Rechte starten
set -e
mkdir -p /data
chown -R node:node /data
chmod 700 /data
exec su-exec node "$@"
