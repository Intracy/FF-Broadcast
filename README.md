# FF Rundown

Selbst gehostete Rundown-App für Live-Produktionen und Events. Läuft auf NAS (Synology, QNAP, Unraid), Linux-Servern, Raspberry Pi, Mac und Windows – im lokalen Netz oder über das Internet. Zugriff per Browser auf PC, Tablet und Smartphone; auf dem Handy lässt sie sich als App zum Homescreen hinzufügen (PWA).

**Keine Abhängigkeiten:** nur Node.js ≥ 22.13 wird benötigt – kein `npm install`, nichts zu kompilieren. Datenbank ist SQLite (eingebaut in Node.js).

## Funktionen

- **Mehrere Rundowns** mit Titel, Datum und Startzeit; Übersicht als **Kacheln oder Liste**, gruppiert nach Live / Heute / Kommend / Vergangen, mit Suche, Filter und Sortierung; duplizieren und löschen
- **Programmpunkte** mit Titel, Beschreibung, Dauer – Start-/Endzeiten werden automatisch berechnet
- **Blöcke & Block-Ende** zum Gruppieren (mit Summe aus Anzahl, Dauer und Zeitfenster)
- **Farben** pro Punkt/Block (Palette oder eigene Farbe)
- **Drag & Drop** zum Umsortieren (Maus und Touch)
- **Eigene Spalten** (Notizen, GFX, Ort, Ton, Kamera …): anlegen, umbenennen, sortieren, löschen; **ein-/ausblenden** pro Benutzer; pro Spalte festlegen, ob sie im öffentlichen Link erscheint
- **Live-Steuerung:** Start, Weiter, Zurück, Beenden, ±Zeit (10 s … 10 min), Sprung zu beliebigem Punkt; Restzeit, Gesamtabweichung zum Plan, voraussichtliches Ende, gemessene Ist-Zeiten pro Punkt
- **Echtzeit-Sync** auf allen Geräten (Server-Sent Events)
- **Mitlaufen:** Bei Start/Weiter/Zurück scrollt die Ansicht automatisch, sodass der laufende Punkt immer ganz oben steht (Editor, öffentlicher Link, Live-Ansicht; abschaltbar). Die Live-Steuerung bleibt dabei oben sichtbar.
- **Handy & Tablet:** Programmpunkte als Karten (leere Spalten werden ausgeblendet, per ⌄ aufklappbar zum Bearbeiten); auf dem Handy feste Live-Steuerleiste unten mit großem „Weiter“-Button; Live-Ansicht ebenfalls als Karten
- **Live-Ansicht:** schreibgeschützte Tabelle mit Statusleiste (Restzeit, Abweichung, Als Nächstes), scrollt automatisch zum laufenden Punkt; alternativ großer Vollbild-Countdown für Bühnenmonitor/Regie (umschaltbar über „Ansicht“; gelb in der letzten Minute, rot blinkend bei Überzeit, Bildschirm bleibt an)
- **Skript pro Programmpunkt:** Das Dokument-Symbol rechts im Feld „Programmpunkt“ klappt darunter einen Editor für den Prompter-Text auf; ein Punkt am Symbol zeigt, dass schon ein Skript hinterlegt ist
- **Prompter** (`/prompter/<id>` bzw. `/prompter/p/<token>`): Teleprompter mit dem Skript der Programmpunkte (oder wahlweise der Beschreibung bzw. einer Textspalte); gleichmäßiges Scrollen mit einstellbarem Tempo, Schriftgröße, Rand und Lesemarke, folgt dem laufenden Punkt, Spiegeln (für Prompter-Glas), Farben umkehren, Großbuchstaben, Abdunkeln über der Marke. Tasten: Leertaste Start/Stopp, ←/→ Tempo, +/− Schrift, Umschalt+↑ Anfang, Umschalt+↓ laufender Punkt. Einstellungen gelten pro Gerät.
- **Öffentlicher Link:** nur lesend, ohne Login – Rundown und Live-Ansicht; jederzeit deaktivierbar oder neu erzeugbar; optional mit **QR-Code** (einblendbar, Vollbild, Download als PNG/SVG)
- **API & Integrationen** (Bitfocus Companion, Stream Deck, OBS/vMix-Overlays, eigene Skripte): HTTP-API pro Rundown mit eigenem Token, Endpunkte direkt im Dialog testbar; im Notfall sofort sperr- und neu erzeugbar (mit Warnung und Bestätigung)
- **Benutzer & Rollen:** Anmeldung mit E-Mail + Passwort

| Rolle | Darf |
|---|---|
| **Admin** | alles, inkl. Benutzerverwaltung |
| **Editor** | Rundowns anlegen/bearbeiten/löschen, Spalten, öffentlicher Link, Companion, Live-Steuerung |
| **Operator** | ansehen + Live-Steuerung |
| **Viewer** | nur ansehen |

**Externe Benutzer (z. B. Dienstleister):** Beim Anlegen „Nur freigegebene (extern)“ wählen. Sie sehen dann ausschließlich Rundowns, die ein Admin ihnen freigibt – mit einer Rolle pro Rundown (Viewer, Operator oder Editor). Freigaben verwaltest du im Rundown unter **Freigaben** oder in der Benutzerliste über das Schloss-Symbol. Interne Benutzer können in einzelnen Rundowns zusätzlich eine höhere Rolle bekommen (z. B. Viewer allgemein, aber Editor für „Finale“). Externe können keine neuen Rundowns anlegen; alles wird serverseitig geprüft – auch für API und Live-Ansicht.

Beim ersten Aufruf legst du im Browser das erste Admin-Konto an.

---

## Installation

**Direkt aus GitHub** (Linux, Raspberry Pi, Mac – Git muss installiert sein):

```bash
git clone https://github.com/Intracy/FF-Broadcast.git
cd FF-Broadcast
sudo ./install-linux.sh          # Raspberry Pi / Linux als Dienst
# oder: docker compose up -d --build
```

Update später: `git pull` im Ordner, danach `sudo ./install-linux.sh` erneut bzw. `docker compose restart`. Der Ordner `data/` wird von Git nicht angefasst.
Ist das Repo privat, fragt `git clone` nach Zugangsdaten – am einfachsten vorher `gh auth login` (GitHub CLI) oder einen Personal Access Token mit Leserecht verwenden.

Alternativ den Ordner als ZIP herunterladen (*Code → Download ZIP*) und wie unten beschrieben starten.


### A) Docker (NAS, Linux-Server, auch Raspberry Pi)

```bash
docker compose up -d --build
```

Danach `http://<IP-des-Servers>:3000` öffnen. Alle Daten liegen im Ordner `./data`.

**Synology (Container Manager):** Projektordner (z. B. `/docker/ff-rundown`) mit diesen Dateien anlegen → Container Manager → *Projekt* → *Erstellen* → Pfad wählen, `docker-compose.yml` wird erkannt → Erstellen.
**QNAP (Container Station):** *Anwendung erstellen* → Inhalt der `docker-compose.yml` einfügen (Ordner vorher hochladen, damit `build: .` funktioniert).
**Unraid / Portainer:** Stack mit der `docker-compose.yml` anlegen.

### B) Linux & Raspberry Pi (ohne Docker)

Für Raspberry Pi OS, Debian und Ubuntu – auf x86 und ARM (Pi 3/4/5, Pi Zero 2 W). Empfohlen: **Raspberry Pi OS Lite 64-bit** (aktuell Debian 13 „Trixie“); ein Pi 4 mit 2 GB reicht problemlos.

```bash
# per git clone (siehe oben) oder Ordner auf den Pi kopieren (USB-Stick, scp, SMB), dann:
cd FF-Broadcast   # bzw. der kopierte App-Ordner
sudo ./install-linux.sh
```

Das Skript installiert bei Bedarf Node.js 22, kopiert die App nach `/opt/ff-rundown`, richtet den Dienst `ff-rundown` ein (startet automatisch beim Booten) und zeigt die Adresse an, z. B. `http://192.168.1.50:3000`. Erneut ausführen = Update (Daten bleiben erhalten). Entfernen: `sudo ./install-linux.sh --remove`.

Nützlich: `systemctl status ff-rundown` · `journalctl -u ff-rundown -f` · anderer Port: `sudo PORT=8080 ./install-linux.sh`.
Nur zum Ausprobieren ohne Dienst: `./start.sh`.

Tipp für den Pi: eine feste IP im Router vergeben, damit die Adresse für Companion & Co. gleich bleibt. Mit `raspberrypi.local:3000` (Hostname) klappt es meist auch ohne feste IP.

### C) Mac (macOS 12 oder neuer, Intel & Apple Silicon)

1. [Node.js 22 LTS](https://nodejs.org) installieren (Installer-Paket, oder `brew install node@22`).
2. Ordner entpacken und **`start-mac.command`** doppelklicken – der Browser öffnet sich automatisch. Das Terminal-Fenster offen lassen.
   Beim ersten Mal meldet macOS evtl. „nicht verifizierter Entwickler“: Rechtsklick auf die Datei → **Öffnen** → **Öffnen**. (Alternativ einmalig im Terminal: `xattr -dr com.apple.quarantine <Ordner>`.)
3. Bei der Firewall-Abfrage „Eingehende Verbindungen erlauben“ bestätigen, damit andere Geräte im Netz zugreifen können.

**Dauerhaft im Hintergrund** (startet automatisch bei der Anmeldung, ohne Terminal-Fenster):
```bash
cd FF-Broadcast   # bzw. der App-Ordner
./install-mac-autostart.sh          # einrichten
./install-mac-autostart.sh --remove # wieder entfernen
```
Log: `data/server.log`. Damit der Mac im Einsatz nicht einschläft: Systemeinstellungen → Energie → Ruhezustand verhindern (oder `caffeinate -s` im Terminal).

### D) Windows

1. [Node.js 22 LTS](https://nodejs.org) installieren.
2. Ordner entpacken, `start-windows.bat` doppelklicken.
3. Beim ersten Start die Windows-Firewall-Abfrage für private Netzwerke erlauben.

Als dauerhafter Dienst: mit [NSSM](https://nssm.cc) (`nssm install FFRundown "C:\Program Files\nodejs\node.exe" "--no-warnings server\index.js"`, Arbeitsverzeichnis = App-Ordner) oder per Docker Desktop.

### Systemvoraussetzungen

| | Minimum |
|---|---|
| Node.js | 22.13 oder neuer (Startskripte prüfen das) |
| RAM | ca. 60–100 MB |
| Plattformen | Linux (x86_64, ARM64, ARMv7), macOS (Intel, Apple Silicon), Windows 10/11; Docker-Image ist Multi-Arch (läuft auch auf dem Pi) |

---

## Zugriff über das Internet

Nicht den Port direkt freigeben, sondern einen **Reverse-Proxy mit HTTPS** davorsetzen und `TRUST_PROXY=true` setzen.

**Caddy** (holt das Zertifikat automatisch):
```
rundown.deine-domain.de {
  reverse_proxy 127.0.0.1:3000
}
```

**Nginx / Nginx Proxy Manager:** normalen Proxy-Host anlegen. Für die Echtzeit-Verbindung Puffern abschalten:
```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_http_version 1.1;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_buffering off;
  proxy_read_timeout 1h;
}
```

**Synology:** Systemsteuerung → Anmeldeportal → Erweitert → Reverse Proxy (HTTPS → localhost:3000), Zertifikat über Let's Encrypt. Bei *Benutzerdefinierte Kopfzeile* „WebSocket“ hinzufügen schadet nicht.

Sicherheit: Passwörter werden mit scrypt gehasht, Sitzungen per signiertem HttpOnly-Cookie, Login-Versuche sind gedrosselt. Benutzer kann nur ein Admin anlegen – es gibt keine offene Registrierung.

---

## API & Integrationen (Companion, Stream Deck, Overlays)

Im Rundown auf **API** klicken (Reiter „Integrationen“) – dort stehen alle URLs mit Kopier-Buttons.

1. Modul **Generic: HTTP Requests** hinzufügen, Base-URL: `http://<server>:3000/api/v1/<TOKEN>`
2. Button-Aktionen (POST oder GET):

| Aktion | Pfad |
|---|---|
| Start | `/start` |
| Weiter | `/next` |
| Zurück | `/prev` |
| Beenden | `/stop` |
| + Zeit | `/plus?seconds=60` |
| − Zeit | `/minus?seconds=60` |
| Sprung zu Punkt | `/goto?item=<ID>` |
| Zurücksetzen | `/reset` |

3. Status: `GET /status` liefert JSON (`title`, `next`, `remaining`, `remaining_sec`, `delta`, `projected_end`, `state` = running/warning/overtime/stopped, `progress`, `item_number`, …).
   Einzelwerte als reiner Text: `/text/remaining`, `/text/title`, `/text/next`, `/text/delta`, `/text/state` usw. – z. B. per Trigger jede Sekunde abfragen und in eine Custom-Variable schreiben.

Der Token wirkt wie ein Passwort für die Live-Steuerung dieses Rundowns. **Notfall:** Im API-Dialog unter „Sicherheit“ „Token sperren & neu erzeugen“ – nach einer Warnung und Eingabe von „NEU“ ist der alte Token sofort ungültig (nur Editor/Admin; Zeitpunkt und Person werden angezeigt und im Server-Log vermerkt).

---

## API-Referenz

Basis-URL: `http://<server>:3000/api/v1/<TOKEN>` (Token im Dialog **API** im Rundown). Die ältere Adresse `/api/companion/<TOKEN>` funktioniert weiterhin. Alle Aktionen gehen per **GET oder POST**; Parameter als Query (`?seconds=30`) oder JSON-Body (`{"seconds":30}`). Antworten sind JSON.

### Lesen

| Endpunkt | Inhalt |
|---|---|
| `GET /cue` | **Aktueller Cue**: `current` (Titel, Beschreibung, alle Spalten als `cells`, Plan-Start/-Ende, `started_at`, `elapsed`, `remaining`, `effective_duration`, `adjust_sec`, `progress`, `state`), dazu `previous`, `next`, `position`/`count` und `live` (Gesamtabweichung, voraussichtliches Ende) |
| `GET /rundown` | **Kompletter Rundown**: Kopfdaten, Spalten, alle Einträge (Punkte, Blöcke, Block-Enden) mit Nummer, Plan-Zeiten, Status (`live`/`next`/`done`/`upcoming`), gemessener Ist-Dauer und Abweichung |
| `GET /status` | Flache Werte für Companion-Variablen |
| `GET /text/<feld>` | Einzelwert als Text, z. B. `/text/remaining` |

### Zeit am laufenden Punkt

| Endpunkt | Wirkung |
|---|---|
| `/add?seconds=30` | Zeit addieren (negativ zum Abziehen, z. B. `seconds=-30`) |
| `/plus?seconds=60` · `/minus?seconds=60` | Zeit hinzufügen / abziehen |
| `/set?time=05:00` | **Restzeit setzen** – der Countdown steht danach exakt auf 05:00 |
| `/setduration?time=10:00` | Gesamtdauer des laufenden Punkts (für diesen Durchlauf) setzen |

Zeitangaben: `seconds=90`, `minutes=1.5` oder `time=01:30` / `1:00:00` / `5m` / `90s`. Ohne laufenden Punkt antworten die Zeit-Endpunkte mit HTTP 409. Die Plan-Dauer im Rundown bleibt unverändert; die Änderung wirkt nur live.

### Steuern

`/start` (optional `?item=<ID>`), `/next`, `/prev`, `/goto?item=<ID>`, `/stop`, `/reset`. Jede Aktion liefert danach den aktuellen Cue (wie `/cue`) zurück.

### Beispiele

```bash
curl http://server:3000/api/v1/TOKEN/cue
curl http://server:3000/api/v1/TOKEN/rundown
curl -X POST "http://server:3000/api/v1/TOKEN/add?seconds=30"
curl -X POST -H "Content-Type: application/json" -d '{"time":"02:00"}' http://server:3000/api/v1/TOKEN/set
```

### Mit Benutzer-Login

Dieselben Daten gibt es für angemeldete Benutzer (Cookie oder `Authorization: Bearer <token>` aus `POST /api/auth/login`):
`GET /api/rundowns/<id>/cue`, `GET /api/rundowns/<id>/export`, sowie Steuerung ab Rolle Operator über `POST /api/rundowns/<id>/live/<aktion>` mit `start`, `next`, `prev`, `goto`, `stop`, `reset`, `adjust`, `setRemaining`, `setDuration` (Body z. B. `{"seconds":-30}` oder `{"time":"05:00"}`).

---

## Konfiguration (Umgebungsvariablen)

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `3000` | HTTP-Port |
| `HOST` | `0.0.0.0` | `127.0.0.1`, wenn nur der Reverse-Proxy zugreifen soll |
| `DATA_DIR` | `./data` | Datenbank (`rundown.db`) und Sitzungsschlüssel |
| `TRUST_PROXY` | `false` | `true` hinter Reverse-Proxy |
| `COOKIE_SECURE` | automatisch | `true`/`false` erzwingen |
| `SESSION_SECRET` | auto-generiert | eigener Schlüssel für Sitzungen |
| `TZ` | System | Zeitzone (für Companion-Uhrzeiten) |
| `BACKUP_DIR` | `data/backups` | Speicherort der Backups (siehe „Backups“) |

## Update auf eine neue Version

Den Ordner **`data` behalten** (dort liegen Datenbank und Benutzer) und alle anderen Dateien durch die neuen ersetzen. Danach den Server neu starten:

| Installation | Neustart nach dem Ersetzen |
|---|---|
| Docker / NAS | `docker compose restart` (bei Installationen vor v1.9.2 einmalig `docker compose up -d --build`) – in Synology Container Manager: Projekt → *Aktion* → *Neu erstellen* |
| Raspberry Pi / Linux | `sudo ./install-linux.sh` erneut ausführen |
| Mac | `start-mac.command` neu starten bzw. `./install-mac-autostart.sh` erneut ausführen |
| Windows | Fenster schließen, `start-windows.bat` erneut starten |

**Prüfen:** Die laufende Version steht oben rechts neben deiner Rolle (z. B. „Admin · v1.6.0“) und unter `http://<server>:3000/api/health`. Geöffnete Browser-Tabs zeigen nach dem Neustart automatisch den Hinweis „Neue Version verfügbar – Jetzt neu laden“.

## Datenschutz & Dateirechte

Alles liegt im Ordner `data/`:

| Datei | Inhalt | Lesbar? |
|---|---|---|
| `rundown.db` (+ `-wal`, `-shm`) | Benutzer (E-Mail, Name, Rolle), Rundowns, öffentliche Links, API-Tokens | Klartext – außer Passwörtern |
| `secret.key` | Schlüssel zum Signieren der Login-Sitzungen | sehr sensibel |

- **Passwörter** werden nie gespeichert, nur ein gesalzener scrypt-Hash – nicht zurückrechenbar.
- Der Server setzt den Ordner beim Start auf **nur für den eigenen Benutzer lesbar** (`700` für den Ordner, `600` für Dateien) – auch bei bestehenden Installationen. Unter Windows gelten stattdessen die Ordnerrechte von Windows.
- Docker: Der Container stellt beim Start sicher, dass der Datenordner dem App-Benutzer gehört, und läuft danach ohne Root-Rechte.
- Den `data`-Ordner nicht als Netzwerkfreigabe freigeben; Backups wie Passwort-Listen behandeln (verschlüsselt aufbewahren).
- Falls Datei oder Backup abhandenkommen: API-Tokens und öffentliche Links neu erzeugen und `secret.key` löschen (alle werden abgemeldet, beim Start entsteht ein neuer Schlüssel).

## Backups

Unter **System** (nur Admins) laufen automatische Sicherungen der kompletten Datenbank:

- **Automatisch** im eingestellten Intervall (Standard: alle 6 Std., die letzten 30 werden behalten) – konsistent auch im laufenden Betrieb.
- **Jetzt sichern** mit optionaler Bezeichnung (z. B. „vor dem Finale“); manuelle Backups werden nie automatisch gelöscht.
- **Vor dem Löschen eines Rundowns** und **vor jeder Wiederherstellung** wird automatisch gesichert.
- **Herunterladen**, **hochladen** (wird vorher geprüft) und **wiederherstellen**. Beim Wiederherstellen startet der Server neu; als Dienst (systemd, Docker, macOS-Autostart) und mit den Startskripten passiert das automatisch.

Ablage: `data/backups/` (nur für den Server lesbar). Besser zusätzlich auf einem anderen Datenträger:

| Variable | Bedeutung |
|---|---|
| `BACKUP_DIR` | anderer Speicherort, z. B. `/mnt/usb/ff-backups` oder eine NAS-Freigabe |
| `BACKUP_INTERVAL_HOURS` | Intervall fest vorgeben (1, 3, 6, 12, 24, 48, 168) |
| `BACKUP_KEEP` | Anzahl automatischer Backups (7, 14, 30, 60, 100) |
| `BACKUP_ENABLED` | `false` schaltet die automatischen Backups ab |

Per Variable gesetzte Werte sind in der Oberfläche gesperrt. Backups enthalten Benutzer, Passwort-Hashes und Tokens – heruntergeladene Dateien sicher aufbewahren.

Manuell geht es weiterhin: Server stoppen und den Ordner `data` kopieren.

## Passwort vergessen / Zugang zurücksetzen

**1. Reset-Link (empfohlen)** – Admin → *Benutzer* → Schlüssel-Symbol → *Reset-Link* → Gültigkeit wählen (1 Std. bis 7 Tage) → Link oder QR-Code weitergeben. Der Benutzer legt sein neues Passwort selbst fest; der Admin kennt es nie. Der Link funktioniert genau einmal, wird nur als Fingerabdruck gespeichert und kann widerrufen werden.

**2. Einladungslink für neue Benutzer** – beim Anlegen „Einladungslink“ wählen: Das Konto ist bis zur Annahme ohne Passwort, der Benutzer setzt es über den Link selbst. In der Liste steht bis dahin „Einladung offen“.

**3. Temporäres Passwort** – Admin setzt ein Passwort (mit „Generieren“) und lässt „Muss beim nächsten Login geändert werden“ an. Der Benutzer kann die App erst nutzen, nachdem er ein eigenes Passwort gewählt hat – das wird auch vom Server erzwungen.

Bei allen Varianten wird der Benutzer auf allen Geräten abgemeldet.

### Notfall: Kein Admin kommt mehr hinein

Auf dem Server im App-Ordner (der Server darf weiterlaufen):

```bash
node server/reset-password.js --list                    # Benutzer anzeigen
node server/reset-password.js admin@example.de          # temporäres Passwort erzeugen und anzeigen
node server/reset-password.js admin@example.de --admin  # zusätzlich (wieder) zum Admin machen
node server/reset-password.js admin@example.de --link   # Reset-Link statt Passwort (24 Std.)
```

| Installation | Befehl |
|---|---|
| Docker / NAS | `docker exec -it ff-rundown node server/reset-password.js admin@example.de` |
| Raspberry Pi / Linux (Dienst) | `cd /opt/ff-rundown && sudo DATA_DIR=/opt/ff-rundown/data node server/reset-password.js admin@example.de` |
| Mac / Windows | im App-Ordner: `node server/reset-password.js admin@example.de` |

Synology ohne SSH: Container Manager → Container *ff-rundown* → *Aktion* → *Terminal öffnen* → *Erstellen* → `sh` und dort den Befehl ausführen.

Das temporäre Passwort muss beim nächsten Login geändert werden.

## Lizenz

MIT – siehe [LICENSE](LICENSE).

## Hinweise

- Alle Schriften (IBM Plex Sans, IBM Plex Mono, Barlow Condensed) sind in der App enthalten (`public/fonts/`, SIL Open Font License). Es werden keine externen Dienste wie Google Fonts kontaktiert – die App läuft komplett offline und DSGVO-freundlich.
- Die App als „App“ installieren: im Browser „Zum Startbildschirm hinzufügen“ (iOS/Android) bzw. „Installieren“ (Chrome/Edge). Dafür ist HTTPS nötig.
