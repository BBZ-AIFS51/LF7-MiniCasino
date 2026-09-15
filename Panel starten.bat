@echo off
rem Startet das Web-Adminpanel und oeffnet den Browser.
rem Zusaetzliche Argumente werden durchgereicht, z.B.:
rem   "Panel starten.bat" --serial COM6
rem   "Panel starten.bat" --host 0.0.0.0
setlocal
chcp 65001 >nul 2>nul
title Mini Casino - Panel starten
cd /d "%~dp0"

echo.
echo   Mini Casino - Adminpanel
echo   ========================
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo   FEHLER: Python wurde nicht gefunden.
  echo   Python installieren oder den Ordner in PATH aufnehmen.
  echo.
  pause
  exit /b 1
)

if not exist "admin\panel.py" (
  echo   FEHLER: admin\panel.py fehlt.
  echo   Diese Datei muss im Projektordner liegen, nicht woanders.
  echo.
  pause
  exit /b 1
)

rem Der serielle Monitor der Arduino IDE haelt den Anschluss fest. Bleibt er
rem offen, scheitert das Panel mit "Zugriff verweigert".
tasklist /fi "imagename eq serial-monitor.exe" 2>nul | find /i "serial-monitor.exe" >nul
if not errorlevel 1 (
  echo   Der serielle Monitor der Arduino IDE laeuft und belegt den Anschluss.
  echo   Ich beende ihn. Die IDE selbst laeuft weiter.
  taskkill /f /im serial-monitor.exe >nul 2>nul
  echo.
)

echo   Starte Panel in einem eigenen Fenster ...
start "Mini Casino Panel" cmd /k python "admin\panel.py" %*

echo   Warte auf den Uno (Reset durch das Oeffnen der Schnittstelle) ...
ping -n 8 127.0.0.1 >nul
start "" http://127.0.0.1:8080

echo.
echo   Fertig. Das Panel laeuft im Fenster "Mini Casino Panel".
echo.
echo   Beenden: dort Strg+C druecken oder das Fenster schliessen.
echo   Wichtig: vor dem naechsten Upload aus der Arduino IDE beenden,
echo   sonst ist der Anschluss belegt.
echo.
ping -n 13 127.0.0.1 >nul
