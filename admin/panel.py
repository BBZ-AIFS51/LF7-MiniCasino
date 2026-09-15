"""Web-Adminpanel fuer das Mini Casino.

Startet einen kleinen Webserver und spricht ueber die serielle Schnittstelle mit
dem Uno (Protokoll siehe MiniCasino/AdminSerial.h).

    python admin/panel.py                      # Port wird gesucht, http://127.0.0.1:8080
    python admin/panel.py --serial COM6
    python admin/panel.py --host 0.0.0.0       # im Netz erreichbar, siehe Warnung

Laeuft mit der Standardbibliothek, auf Windows wie auf dem Raspberry Pi.
pyserial wird benutzt, wenn es installiert ist, ist aber nicht noetig.

Wichtig: Das Oeffnen der Schnittstelle loest beim Uno einen Reset aus. Die
Guthaben liegen im EEPROM und ueberstehen das; eine laufende Sitzung nicht.
"""
from __future__ import annotations

import argparse
import collections
import json
import os
import socket
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BAUD = 115200
RESET_WARTEN = 2.5   # Nach dem Oeffnen laeuft der Bootloader.
ANTWORT_TIMEOUT = 4.0


# --------------------------------------------------------------------------
# Serielle Schnittstelle: pyserial, sonst Win32 per ctypes, sonst POSIX.
# --------------------------------------------------------------------------
class SerialBase:
    def write(self, data: bytes) -> None: raise NotImplementedError
    def read(self, n: int) -> bytes: raise NotImplementedError
    def close(self) -> None: raise NotImplementedError


class PySerialPort(SerialBase):
    def __init__(self, port: str):
        import serial
        self._s = serial.Serial(port, BAUD, timeout=0.05)

    def write(self, data): self._s.write(data)
    def read(self, n): return self._s.read(n)
    def close(self): self._s.close()


class WindowsSerialPort(SerialBase):
    """Minimaler Ersatz fuer pyserial ueber die Win32-API."""

    def __init__(self, port: str):
        import ctypes
        from ctypes import wintypes as w
        self._ct = ctypes
        self._k32 = ctypes.WinDLL("kernel32", use_last_error=True)

        class DCB(ctypes.Structure):
            _fields_ = [
                ("DCBlength", w.DWORD), ("BaudRate", w.DWORD), ("flags", w.DWORD),
                ("wReserved", w.WORD), ("XonLim", w.WORD), ("XoffLim", w.WORD),
                ("ByteSize", ctypes.c_byte), ("Parity", ctypes.c_byte),
                ("StopBits", ctypes.c_byte), ("XonChar", ctypes.c_char),
                ("XoffChar", ctypes.c_char), ("ErrorChar", ctypes.c_char),
                ("EofChar", ctypes.c_char), ("EvtChar", ctypes.c_char),
                ("wReserved1", w.WORD),
            ]

        class TIMEOUTS(ctypes.Structure):
            _fields_ = [("ReadIntervalTimeout", w.DWORD),
                        ("ReadTotalTimeoutMultiplier", w.DWORD),
                        ("ReadTotalTimeoutConstant", w.DWORD),
                        ("WriteTotalTimeoutMultiplier", w.DWORD),
                        ("WriteTotalTimeoutConstant", w.DWORD)]

        handle = self._k32.CreateFileW(
            f"\\\\.\\{port}", 0x80000000 | 0x40000000, 0, None, 3, 0, None)
        if handle == ctypes.c_void_p(-1).value:
            raise OSError(f"COM-Port {port} laesst sich nicht oeffnen "
                          f"(Fehler {ctypes.get_last_error()}). "
                          f"Laeuft noch ein serieller Monitor?")
        self._h = w.HANDLE(handle)

        dcb = DCB()
        dcb.DCBlength = ctypes.sizeof(DCB)
        if not self._k32.GetCommState(self._h, ctypes.byref(dcb)):
            raise OSError("GetCommState fehlgeschlagen")
        dcb.BaudRate = BAUD
        dcb.ByteSize = 8
        dcb.Parity = 0
        dcb.StopBits = 0
        # fBinary | fDtrControl=enable | fRtsControl=enable
        dcb.flags = 0x01 | (1 << 4) | (1 << 12)
        if not self._k32.SetCommState(self._h, ctypes.byref(dcb)):
            raise OSError("SetCommState fehlgeschlagen")

        t = TIMEOUTS(0, 0, 50, 0, 200)
        self._k32.SetCommTimeouts(self._h, ctypes.byref(t))

    def write(self, data):
        from ctypes import wintypes as w
        geschrieben = w.DWORD(0)
        self._k32.WriteFile(self._h, data, len(data),
                            self._ct.byref(geschrieben), None)

    def read(self, n):
        from ctypes import wintypes as w
        puffer = (self._ct.c_char * n)()
        gelesen = w.DWORD(0)
        if not self._k32.ReadFile(self._h, puffer, n,
                                  self._ct.byref(gelesen), None):
            return b""
        return bytes(puffer[:gelesen.value])

    def close(self):
        self._k32.CloseHandle(self._h)


class PosixSerialPort(SerialBase):
    """Fuer den Raspberry Pi: rohes tty ueber termios."""

    def __init__(self, port: str):
        import termios
        self._fd = os.open(port, os.O_RDWR | os.O_NOCTTY | os.O_NONBLOCK)
        attrs = termios.tcgetattr(self._fd)
        iflag, oflag, cflag, lflag, ispeed, ospeed, cc = attrs
        geschwindigkeit = getattr(termios, f"B{BAUD}")
        iflag = 0
        oflag = 0
        lflag = 0
        cflag = termios.CS8 | termios.CREAD | termios.CLOCAL
        cc = list(cc)
        cc[termios.VMIN] = 0
        cc[termios.VTIME] = 0
        termios.tcsetattr(self._fd, termios.TCSANOW,
                          [iflag, oflag, cflag, lflag,
                           geschwindigkeit, geschwindigkeit, cc])

    def write(self, data): os.write(self._fd, data)

    def read(self, n):
        try:
            return os.read(self._fd, n)
        except BlockingIOError:
            return b""
        except OSError:
            return b""

    def close(self): os.close(self._fd)


def port_oeffnen(port: str) -> SerialBase:
    try:
        import serial  # noqa: F401
        return PySerialPort(port)
    except ImportError:
        pass
    if os.name == "nt":
        return WindowsSerialPort(port)
    return PosixSerialPort(port)


def port_suchen() -> str | None:
    """Ersten plausiblen Anschluss finden."""
    if os.name == "nt":
        import winreg
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,
                                r"HARDWARE\DEVICEMAP\SERIALCOMM") as key:
                gefunden = []
                for i in range(winreg.QueryInfoKey(key)[1]):
                    name, wert, _ = winreg.EnumValue(key, i)
                    # USB-Anschluesse zuerst: der Uno meldet sich als usbser.
                    gefunden.append((0 if "USB" in name.upper() else 1, wert))
                gefunden.sort()
                return gefunden[0][1] if gefunden else None
        except OSError:
            return None
    import glob
    treffer = sorted(glob.glob("/dev/ttyACM*") + glob.glob("/dev/ttyUSB*"))
    return treffer[0] if treffer else None


# --------------------------------------------------------------------------
# Protokoll
# --------------------------------------------------------------------------
class Casino:
    """Haelt die Verbindung offen und serialisiert alle Zugriffe."""

    def __init__(self, port: str):
        self.portname = port
        self._port = port_oeffnen(port)
        self._lock = threading.Lock()
        self._antworten: collections.deque[str] = collections.deque()
        self._log: collections.deque[str] = collections.deque(maxlen=300)
        self._rest = b""
        self._laeuft = True
        self._leser = threading.Thread(target=self._pumpe, daemon=True)
        self._leser.start()
        time.sleep(RESET_WARTEN)          # Reset durch das Oeffnen abwarten.
        self._antworten.clear()

    def _pumpe(self):
        while self._laeuft:
            roh = self._port.read(512)
            if not roh:
                time.sleep(0.02)
                continue
            self._rest += roh
            while b"\n" in self._rest:
                zeile, self._rest = self._rest.split(b"\n", 1)
                text = zeile.decode("ascii", "replace").strip()
                if not text:
                    continue
                if text.startswith("#"):
                    self._antworten.append(text)
                else:
                    self._log.append(text)

    def log(self) -> list[str]:
        return list(self._log)

    def befehl(self, zeile: str) -> list[str]:
        """Befehl senden und alle #-Zeilen bis OK/ERR einsammeln."""
        with self._lock:
            self._antworten.clear()
            self._port.write((zeile + "\n").encode("ascii"))
            ende = time.time() + ANTWORT_TIMEOUT
            gesammelt: list[str] = []
            while time.time() < ende:
                if not self._antworten:
                    time.sleep(0.01)
                    continue
                text = self._antworten.popleft()
                gesammelt.append(text)
                if text.startswith("#OK") or text.startswith("#ERR"):
                    return gesammelt
            raise TimeoutError(f"Keine Antwort auf '{zeile}'. Uno verbunden?")

    @staticmethod
    def _pruefe(antwort: list[str]) -> str:
        letzte = antwort[-1]
        if letzte.startswith("#ERR"):
            raise RuntimeError(letzte[5:].strip() or "Unbekannter Fehler")
        return letzte

    def status(self) -> dict:
        kopf = self._pruefe(self.befehl("PING"))
        werte = {}
        for stueck in kopf.split()[2:]:
            if "=" in stueck:
                schluessel, _, wert = stueck.partition("=")
                werte[schluessel] = wert
        zeilen = self.befehl("LIST")
        self._pruefe(zeilen)
        konten = []
        for zeile in zeilen:
            if not zeile.startswith("#ROW"):
                continue
            teile = zeile.split()
            _, platz, uid, bestaetigt, guthaben = teile[:5]
            konten.append({
                "slot": int(platz), "uid": uid,
                "funded": bestaetigt == "1",
                "balance": int(guthaben),
                "stake": int(teile[5]) if len(teile) > 5 else 10,
                "flag": int(teile[6]) if len(teile) > 6 else 0,
            })
        return {
            "version": kopf.split()[2] if len(kopf.split()) > 2 else "?",
            "slots": int(werte.get("slots", 0)),
            "used": len(konten),
            "sound": int(werte.get("sound", 0)),
            "session": int(werte.get("session", -1)),
            "accounts": konten,
            "port": self.portname,
        }

    def setzen(self, slot: int, guthaben: int):
        self._pruefe(self.befehl(f"SET {int(slot)} {int(guthaben)}"))

    def einsatz(self, slot: int, wert: int):
        self._pruefe(self.befehl(f"STAKE {int(slot)} {int(wert)}"))

    def zustand(self, slot: int, art: int):
        self._pruefe(self.befehl(f"FLAG {int(slot)} {int(art)}"))

    def anlegen(self, uid: str, guthaben: int):
        sauber = "".join(c for c in uid if c.isalnum()).upper()
        self._pruefe(self.befehl(f"ADD {sauber} {int(guthaben)}"))

    def freigeben(self, slot: int):
        self._pruefe(self.befehl(f"FREE {int(slot)}"))

    def ton(self, stufe: int):
        self._pruefe(self.befehl(f"SOUND {int(stufe)}"))

    def alles_loeschen(self):
        self._pruefe(self.befehl("WIPE JA"))

    def schliessen(self):
        self._laeuft = False
        time.sleep(0.1)
        self._port.close()


# --------------------------------------------------------------------------
# Webserver
# --------------------------------------------------------------------------
HTML = r"""<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Mini Casino Admin</title>
<style>
:root{--bg:#f6f7f9;--karte:#fff;--rand:#d9dde3;--text:#1b1f24;--matt:#5b6470;
      --akzent:#2f6f4f;--warn:#a4332a;--schatten:0 1px 3px rgba(0,0,0,.08)}
@media(prefers-color-scheme:dark){:root{--bg:#14171a;--karte:#1d2227;--rand:#2f363d;
      --text:#e6e9ed;--matt:#9aa4b0;--akzent:#4caf7d;--warn:#e06a5e;--schatten:none}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
.huelle{max-width:900px;margin:0 auto;padding:24px 16px 60px}
h1{font-size:20px;margin:0 0 4px}
.status{color:var(--matt);font-size:13px;margin-bottom:20px}
.karte{background:var(--karte);border:1px solid var(--rand);border-radius:10px;
       padding:16px;margin-bottom:16px;box-shadow:var(--schatten)}
.karte h2{font-size:14px;text-transform:uppercase;letter-spacing:.04em;
          color:var(--matt);margin:0 0 12px;font-weight:600}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--rand)}
th{font-size:12px;color:var(--matt);font-weight:600}
td.uid{font-family:ui-monospace,Consolas,monospace;font-size:13px}
tr.aktiv td{background:color-mix(in srgb,var(--akzent) 12%,transparent)}
tr.gesperrt td{background:color-mix(in srgb,var(--warn) 10%,transparent)}
tr.gesperrt td.uid{text-decoration:line-through;opacity:.65}
.inf{font-size:19px;color:var(--akzent);font-weight:600}
small{color:var(--matt)}
input,select,button{font:inherit;padding:6px 10px;border:1px solid var(--rand);
      border-radius:6px;background:var(--karte);color:var(--text)}
input[type=number]{width:100px}
button{cursor:pointer}
button.haupt{background:var(--akzent);border-color:var(--akzent);color:#fff}
button.gefahr{color:var(--warn);border-color:var(--warn)}
.reihe{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.hinweis{color:var(--matt);font-size:13px;margin-top:8px}
#meldung{position:fixed;left:50%;transform:translateX(-50%);bottom:20px;
  background:var(--text);color:var(--bg);padding:9px 16px;border-radius:7px;
  font-size:14px;opacity:0;transition:opacity .2s;pointer-events:none}
#meldung.an{opacity:1}
pre{margin:0;max-height:240px;overflow:auto;font-size:12px;line-height:1.45;
    font-family:ui-monospace,Consolas,monospace;color:var(--matt)}
@media(max-width:620px){th:nth-child(3),td:nth-child(3){display:none}}
</style></head><body>
<div class="huelle">
  <h1>Mini Casino &ndash; Verwaltung</h1>
  <div class="status" id="kopf">verbinde&hellip;</div>

  <div class="karte">
    <h2>Konten</h2>
    <table><thead><tr><th>Platz</th><th>UID</th><th>Status</th>
      <th>Guthaben</th><th>Einsatz</th><th></th></tr></thead>
      <tbody id="konten"></tbody></table>
    <div class="hinweis">
      <b>gesperrt</b>: die Karte wird am Automaten abgewiesen, das Guthaben
      bleibt gespeichert. <b>Admin &infin;</b>: spielt mit unbegrenztem
      Guthaben, es wird nichts abgebucht und nichts gutgeschrieben.<br>
      Einsatz: Vielfaches von 10, hoechstens 2550. Die Spieler
      koennen ihn am Automaten selbst aendern (Schwarz gedrueckt halten).<br>
      Freigeben loescht den Eintrag. Die Karte gilt danach als unbekannt und
      bekommt beim naechsten Auflegen wieder ein Startguthaben.</div>
  </div>

  <div class="karte">
    <h2>Karte von Hand anlegen</h2>
    <div class="reihe">
      <input id="neueUid" placeholder="UID hex, z.B. 04CABD5C110189" size="24">
      <input id="neuerWert" type="number" value="100" min="0">
      <button class="haupt" onclick="anlegen()">Anlegen</button>
    </div>
    <div class="hinweis">8, 14 oder 20 Hexzeichen (4, 7 oder 10 Byte).</div>
  </div>

  <div class="karte">
    <h2>Automat</h2>
    <div class="reihe">
      <label for="ton">Ton</label>
      <select id="ton" onchange="tonSetzen()">
        <option value="0">laut</option><option value="1">leise</option>
        <option value="2">aus</option>
      </select>
      <button class="gefahr" onclick="alleLoeschen()">Alles loeschen&hellip;</button>
    </div>
  </div>

  <div class="karte">
    <h2>Log</h2>
    <pre id="log">&nbsp;</pre>
  </div>
</div>
<div id="meldung"></div>
<script>
let zustand = null, tippt = false;

function melde(text, dauer = 2200) {
  const m = document.getElementById('meldung');
  m.textContent = text; m.classList.add('an');
  clearTimeout(m._t); m._t = setTimeout(() => m.classList.remove('an'), dauer);
}

async function api(pfad, daten) {
  const antwort = await fetch(pfad, daten ? {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(daten)
  } : undefined);
  const ergebnis = await antwort.json();
  if (!antwort.ok) throw new Error(ergebnis.error || 'Fehler');
  return ergebnis;
}

function zeichne(s) {
  zustand = s;
  document.getElementById('kopf').textContent =
    `${s.version} an ${s.port} · ${s.used} von ${s.slots} Plaetzen belegt` +
    (s.session >= 0 ? ` · Sitzung auf Platz ${s.session}` : ' · keine Sitzung');
  if (!tippt) document.getElementById('ton').value = s.sound;
  const koerper = document.getElementById('konten');
  if (tippt) return;
  koerper.innerHTML = s.accounts.map(k => `
    <tr class="${k.slot === s.session ? 'aktiv' : ''} ${k.flag === 1 ? 'gesperrt' : ''}">
      <td>${k.slot}</td>
      <td class="uid">${k.uid}</td>
      <td><select onfocus="tippt=true" onblur="tippt=false"
            onchange="setzeZustand(${k.slot}, this.value)">
          <option value="0"${k.flag === 0 ? ' selected' : ''}>normal</option>
          <option value="1"${k.flag === 1 ? ' selected' : ''}>gesperrt</option>
          <option value="2"${k.flag === 2 ? ' selected' : ''}>Admin &infin;</option>
        </select>${k.funded ? '' : ' <small>ohne Konto</small>'}</td>
      <td>${k.flag === 2 ? '<span class="inf">inf</span>' :
        `<input type="number" min="0" value="${k.balance}"
            onfocus="tippt=true" onblur="tippt=false"
            onchange="setzen(${k.slot}, this.value)">`}</td>
      <td><input type="number" min="10" max="2550" step="10" value="${k.stake}"
            onfocus="tippt=true" onblur="tippt=false"
            onchange="einsatz(${k.slot}, this.value)"></td>
      <td><button class="gefahr" onclick="freigeben(${k.slot})">Freigeben</button></td>
    </tr>`).join('') ||
    '<tr><td colspan="6" style="color:var(--matt)">Noch keine Karte registriert.</td></tr>';
}

async function laden() {
  try {
    zeichne(await api('/api/state'));
    const l = await api('/api/log');
    const pre = document.getElementById('log');
    const unten = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
    pre.textContent = l.lines.join('\n') || ' ';
    if (unten) pre.scrollTop = pre.scrollHeight;
  } catch (e) { document.getElementById('kopf').textContent = 'Fehler: ' + e.message; }
}

async function setzen(slot, wert) {
  try { await api('/api/set', {slot, balance: Number(wert)}); melde(`Platz ${slot} = ${wert}`); }
  catch (e) { melde('Fehler: ' + e.message, 4000); }
  tippt = false; laden();
}
async function einsatz(slot, wert) {
  try { await api('/api/stake', {slot, stake: Number(wert)}); melde(`Einsatz Platz ${slot} = ${wert}`); }
  catch (e) { melde('Fehler: ' + e.message, 4000); }
  tippt = false; laden();
}
async function setzeZustand(slot, art) {
  try { await api('/api/flag', {slot, flag: Number(art)}); melde('Zustand gesetzt'); }
  catch (e) { melde('Fehler: ' + e.message, 4000); }
  tippt = false; laden();
}
async function anlegen() {
  const uid = document.getElementById('neueUid').value.trim();
  const wert = Number(document.getElementById('neuerWert').value);
  if (!uid) return melde('UID fehlt');
  try { await api('/api/add', {uid, balance: wert}); melde('Angelegt');
        document.getElementById('neueUid').value = ''; }
  catch (e) { melde('Fehler: ' + e.message, 4000); }
  laden();
}
async function freigeben(slot) {
  const k = zustand.accounts.find(x => x.slot === slot);
  if (!confirm(`Platz ${slot} (${k.uid}) mit ${k.balance} Punkten freigeben?\n\n` +
               `Die Karte bekommt beim naechsten Auflegen wieder ein Startguthaben.`)) return;
  try { await api('/api/free', {slot}); melde('Freigegeben'); }
  catch (e) { melde('Fehler: ' + e.message, 4000); }
  laden();
}
async function tonSetzen() {
  try { await api('/api/sound', {level: Number(document.getElementById('ton').value)}); melde('Ton gesetzt'); }
  catch (e) { melde('Fehler: ' + e.message, 4000); }
  laden();
}
async function alleLoeschen() {
  if (prompt('Loescht ALLE Karten und ALLE Guthaben.\nZum Bestaetigen LOESCHEN eingeben:') !== 'LOESCHEN') return;
  try { await api('/api/wipe', {confirm: 'JA'}); melde('Alles geloescht'); }
  catch (e) { melde('Fehler: ' + e.message, 4000); }
  laden();
}

laden();
setInterval(laden, 3000);
</script></body></html>
"""


class Panelserver(ThreadingHTTPServer):
    """Belegt den Port exklusiv.

    Ohne das darf sich unter Windows ein zweiter Start auf denselben Port
    legen. Anfragen landen dann abwechselnd bei beiden Prozessen, und weil nur
    einer die serielle Schnittstelle hat, haengt das Panel scheinbar grundlos.
    """

    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


class Handler(BaseHTTPRequestHandler):
    casino: Casino = None  # wird beim Start gesetzt

    def log_message(self, *args):
        pass  # Zugriffe nicht in die Konsole spammen.

    def _senden(self, code: int, typ: str, koerper: bytes):
        self.send_response(code)
        self.send_header("Content-Type", typ)
        self.send_header("Content-Length", str(len(koerper)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(koerper)
        except (ConnectionError, OSError):
            pass  # Browser hat abgebrochen, nicht der Rede wert.

    def _json(self, daten, code=200):
        self._senden(code, "application/json; charset=utf-8",
                     json.dumps(daten).encode("utf-8"))

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            return self._senden(200, "text/html; charset=utf-8", HTML.encode("utf-8"))
        try:
            if self.path == "/api/state":
                return self._json(self.casino.status())
            if self.path == "/api/log":
                return self._json({"lines": self.casino.log()})
        except Exception as fehler:
            return self._json({"error": str(fehler)}, 500)
        self._json({"error": "unbekannt"}, 404)

    def do_POST(self):
        laenge = int(self.headers.get("Content-Length") or 0)
        try:
            daten = json.loads(self.rfile.read(laenge) or b"{}")
        except ValueError:
            return self._json({"error": "ungueltiges JSON"}, 400)
        try:
            if self.path == "/api/set":
                self.casino.setzen(daten["slot"], daten["balance"])
            elif self.path == "/api/stake":
                self.casino.einsatz(daten["slot"], daten["stake"])
            elif self.path == "/api/flag":
                self.casino.zustand(daten["slot"], daten["flag"])
            elif self.path == "/api/add":
                self.casino.anlegen(daten["uid"], daten["balance"])
            elif self.path == "/api/free":
                self.casino.freigeben(daten["slot"])
            elif self.path == "/api/sound":
                self.casino.ton(daten["level"])
            elif self.path == "/api/wipe":
                if daten.get("confirm") != "JA":
                    return self._json({"error": "nicht bestaetigt"}, 400)
                self.casino.alles_loeschen()
            else:
                return self._json({"error": "unbekannt"}, 404)
        except (KeyError, TypeError, ValueError) as fehler:
            return self._json({"error": f"ungueltige Angabe: {fehler}"}, 400)
        except Exception as fehler:
            return self._json({"error": str(fehler)}, 500)
        self._json({"ok": True})


def main():
    p = argparse.ArgumentParser(description="Web-Adminpanel fuer das Mini Casino")
    p.add_argument("--serial", help="COM6 bzw. /dev/ttyACM0; sonst wird gesucht")
    p.add_argument("--host", default="127.0.0.1",
                   help="0.0.0.0 macht das Panel im Netz erreichbar")
    p.add_argument("--port", type=int, default=8080)
    args = p.parse_args()

    port = args.serial or port_suchen()
    if not port:
        sys.exit("Kein serieller Anschluss gefunden. Mit --serial angeben.")

    # Erst den Port belegen. Laeuft schon ein Panel, wird die serielle
    # Schnittstelle gar nicht erst angefasst.
    try:
        server = Panelserver((args.host, args.port), Handler)
    except OSError as fehler:
        sys.exit(f"Port {args.port} ist belegt - laeuft das Panel schon?" \
                 f"\nDann das vorhandene Fenster benutzen, oder mit --port" \
                 f" einen anderen Port waehlen.\n({fehler})")

    print(f"Verbinde mit {port} ...")
    try:
        casino = Casino(port)
    except OSError as fehler:
        server.server_close()
        sys.exit(f"{fehler}")

    try:
        status = casino.status()
    except Exception as fehler:
        casino.schliessen()
        server.server_close()
        sys.exit(f"Keine Antwort vom Uno: {fehler}\n"
                 f"Laeuft dort der aktuelle Sketch mit AdminSerial.h?")

    print(f"Verbunden: {status['version']}, {status['used']} von "
          f"{status['slots']} Plaetzen belegt.")
    if args.host not in ("127.0.0.1", "localhost"):
        print("ACHTUNG: Das Panel ist ohne Passwort im Netz erreichbar. "
              "Wer es aufruft, kann Guthaben frei vergeben.")

    Handler.casino = casino
    sichtbar = "127.0.0.1" if args.host == "0.0.0.0" else args.host
    print(f"Panel laeuft: http://{sichtbar}:{args.port}   (Strg+C beendet)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nBeende ...")
    finally:
        server.server_close()
        casino.schliessen()


if __name__ == "__main__":
    main()
