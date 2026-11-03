@echo off
title FF Rundown
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js wurde nicht gefunden. Bitte Node.js 22 LTS oder neuer installieren: https://nodejs.org
  pause
  exit /b 1
)
node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=13)?0:1)"
if errorlevel 1 (
  echo Node.js ist zu alt - mindestens Version 22.13 wird benoetigt: https://nodejs.org
  pause
  exit /b 1
)
if "%PORT%"=="" set PORT=3000
echo Starte FF Rundown auf Port %PORT% ...
node --no-warnings server\index.js
pause
