/* Mini Casino viewer: the admin protocol, a byte-exact port of MiniCasino/AdminSerial.h.

   Line based, on the same serial port as the log. Replies start with '#', log lines with '['.
   Commands (case does not matter, end with a newline):
     PING  LIST  SET <platz> <wert>  STAKE <platz> <wert>  ADD <uidhex> <wert>
     FLAG <platz> <0|1|2>  FREE <platz>  SOUND <0|1|2>  CARD <uidhex>  WIPE JA
   Everything the firmware does is kept, quirks included: lines are cut at ADMIN_MAX - 1 = 47
   bytes, only spaces separate words, a number with more than nine digits is invalid, the slot is
   an AVR int (16 bit, so 65536 is slot 0), 'JA' is case-sensitive, ADD on a known UID sets its
   balance, CARD takes the same path as a real scan.

   The protocol runs inside the simulated Uno: `host` is the sketch's global scope (MC.Sim), with
   uidListe (MC.UidRegistry), spielAktiv, spielSlot, spielGuthaben, spielEinsatz, spielUnbegrenzt,
   tonStufe, spielMenue(), beendeSitzung(manuell), legeKarteAuf(uidBytes, laenge), Serial
   ({ print, println }), the rules (MC.Rules) and the TON_* levels. */
(function () {
  'use strict';
  const MC = window.MC = window.MC || {};

  class AdminProtocol {
    constructor(host) {
      this.host = host;
      const fw = window.MC_FW || {};
      this.ADMIN_MAX = (fw.rules && fw.rules.ADMIN_MAX) || 48;
      this.adminZeile = [];   // char adminZeile[ADMIN_MAX], as bytes
    }

    // adminService(): consume received bytes; every '\n' runs one command.
    // Zeilen laenger als ADMIN_MAX werden abgeschnitten und dann als unbekannter Befehl abgewiesen.
    // after() is called after every executed command (the sim collects the replies per line).
    service(bytes, after) {
      let commands = 0;
      for (const b of bytes) {
        const c = typeof b === 'number' ? b : b.charCodeAt(0);
        if (c === 13) continue;                     // '\r'
        if (c === 10) {                             // '\n'
          if (this.adminZeile.length) {
            const zeile = String.fromCharCode.apply(null, this.adminZeile);
            this.adminZeile = [];
            this.adminBefehl(zeile);
            commands++;
            if (after) after();
          }
          this.adminZeile = [];
          continue;
        }
        if (this.adminZeile.length < this.ADMIN_MAX - 1) this.adminZeile.push(c & 0xFF);
      }
      return commands;
    }

    // ---- helpers, exactly as in AdminSerial.h
    adminFehler(grund) {
      const S = this.host.Serial;
      S.print('#ERR ');
      S.println(grund);
    }
    // "#OK <befehl> <platz> <wert>"; wert < 0 laesst ihn weg.
    adminOk(cmd, platz, wert) {
      const S = this.host.Serial;
      S.print('#OK ');
      S.print(cmd);
      S.print(' ');
      S.print(platz);
      if (wert >= 0) { S.print(' '); S.print(wert); }
      S.println();
    }
    // Dezimalzahl ohne Vorzeichen. Fehlt sie oder steht Unsinn darin: -1.
    static adminZahl(text) {
      if (!text) return -1;
      let wert = 0;
      for (let i = 0; i < text.length; i++) {
        const c = text.charCodeAt(i);
        if (c < 48 || c > 57 || wert > 99999999) return -1;
        wert = wert * 10 + (c - 48);
      }
      return wert;
    }
    static hexWert(c) {
      if (c >= 48 && c <= 57) return c - 48;
      c |= 0x20;   // Kleinbuchstabe
      return c >= 97 && c <= 102 ? c - 97 + 10 : 16;
    }
    // Hexpaare in Bytes wandeln. Liefert { size: 4|7|10, uid } oder size 0 bei Unsinn.
    static adminUidLesen(text) {
      const uid = [];
      if (!text) return { size: 0, uid };
      let i = 0;
      while (i + 1 < text.length) {
        const hoch = AdminProtocol.hexWert(text.charCodeAt(i)), tief = AdminProtocol.hexWert(text.charCodeAt(i + 1));
        if (uid.length >= 10 || hoch > 15 || tief > 15) return { size: 0, uid };
        uid.push((hoch << 4) | tief);
        i += 2;
      }
      if (i < text.length) return { size: 0, uid };   // ungerade Anzahl Zeichen
      const n = uid.length;
      return { size: n === 4 || n === 7 || n === 10 ? n : 0, uid };
    }

    adminBefehl(zeile) {
      const h = this.host, S = h.Serial, uidListe = h.uidListe, R = h.Rules;
      // strtok(zeile, " "): only spaces separate, runs of spaces count as one
      const words = zeile.split(' ').filter(w => w.length);
      if (!words.length) return;
      const cmd = words[0].replace(/[a-z]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 32));
      const a1 = words.length > 1 ? words[1] : null, a2 = words.length > 2 ? words[2] : null;
      const z1 = AdminProtocol.adminZahl(a1), z2 = AdminProtocol.adminZahl(a2);
      const slot = (z1 << 16) >> 16;                 // int slot = (int)z1;  (int is 16 bit on AVR)
      const sitzungHier = h.spielAktiv && h.spielSlot === slot;
      let size = 0, uid = null;

      if (cmd === 'PING') {
        let belegt = 0;
        for (let s = 0; s < uidListe.capacity(); ++s) if (uidListe.entry(s)) ++belegt;
        S.print('#OK PING v11 slots=');
        S.print(uidListe.capacity());
        S.print(' used=');
        S.print(belegt);
        S.print(' sound=');
        S.print(h.tonStufe);
        S.print(' session=');
        S.println(h.spielAktiv ? h.spielSlot : -1);
        return;
      }
      if (cmd === 'LIST') {
        let n = 0;
        for (let s = 0; s < uidListe.capacity(); ++s) {
          const e = uidListe.entry(s);
          if (!e) continue;
          ++n;
          S.print('#ROW ');
          S.print(s);
          S.print(' ');
          for (let i = 0; i < e.length; ++i) {
            if (e[i] < 0x10) S.print('0');
            S.print(e[i].toString(16).toUpperCase());
          }
          S.print(' ');
          S.print(uidListe.funded(s) ? 1 : 0);
          S.print(' ');
          S.print(uidListe.balance(s));
          S.print(' ');
          const einheiten = uidListe.stakeUnits(s);
          S.print(einheiten ? einheiten * R.STAKE_SCHRITT : R.STAKE);
          S.print(' ');
          S.println(uidListe.flag(s));
        }
        S.print('#OK LIST ');
        S.println(n);
        return;
      }
      if (cmd === 'SET') {
        if (z1 < 0 || z2 < 0) { this.adminFehler('SET <platz> <wert>'); return; }
        if (!uidListe.confirmed(slot)) { this.adminFehler('Platz nicht belegt'); return; }
        if (!uidListe.setBalance(slot, z2 >>> 0)) { this.adminFehler('EEPROM-Fehler'); return; }
        // Eine laufende Sitzung auf diesem Platz sofort nachziehen.
        if (sitzungHier) { h.spielGuthaben = z2 >>> 0; h.spielMenue(); }
        this.adminOk(cmd, slot, z2);
        return;
      }
      if (cmd === 'STAKE') {
        if (z1 < 0 || z2 < 0 || R.checkStake(z2 >>> 0, R.STAKE_MAX)) {
          this.adminFehler('STAKE <platz> <10..2550, 10er>');
          return;
        }
        if (!uidListe.funded(slot)) { this.adminFehler('Platz ohne Konto'); return; }
        if (!uidListe.setStakeUnits(slot, Math.floor(z2 / R.STAKE_SCHRITT) & 0xFF)) {
          this.adminFehler('EEPROM-Fehler');
          return;
        }
        if (sitzungHier) { h.spielEinsatz = z2 >>> 0; h.spielMenue(); }
        this.adminOk(cmd, slot, z2);
        return;
      }
      if (cmd === 'FLAG') {
        if (z1 < 0 || z2 < 0 || z2 > 2) { this.adminFehler('FLAG <platz> <0|1|2>'); return; }
        if (!uidListe.confirmed(slot)) { this.adminFehler('Platz nicht belegt'); return; }
        if (!uidListe.setFlag(slot, z2)) { this.adminFehler('EEPROM-Fehler'); return; }
        // Sperre wirkt sofort, auch mitten in einer laufenden Sitzung.
        if (sitzungHier) {
          if (z2 === 1) h.beendeSitzung(true);
          else { h.spielUnbegrenzt = z2 === 2; h.spielMenue(); }
        }
        this.adminOk(cmd, slot, z2);
        return;
      }
      if (cmd === 'ADD') {
        ({ size, uid } = AdminProtocol.adminUidLesen(a1));
        if (!size || z2 < 0) { this.adminFehler('ADD <uid 8/14/20 hex> <wert>'); return; }
        const platz = uidListe.reserve(uid, size);
        if (platz < 0) { this.adminFehler(platz === -3 ? 'Liste voll' : 'Liste gesperrt'); return; }
        if (!uidListe.confirm(platz) || !uidListe.setBalance(platz, z2 >>> 0)) {
          this.adminFehler('Angelegt, Gutschrift fehlt');
          return;
        }
        this.adminOk(cmd, platz, z2);
        return;
      }
      if (cmd === 'FREE') {
        if (z1 < 0) { this.adminFehler('FREE <platz>'); return; }
        if (sitzungHier) h.beendeSitzung(true);
        if (!uidListe.clearSlot(slot)) { this.adminFehler('Nicht freigegeben'); return; }
        this.adminOk(cmd, slot, -1);
        return;
      }
      if (cmd === 'SOUND') {
        if (z1 < 0 || z1 > 2) { this.adminFehler('SOUND <0|1|2>'); return; }
        h.tonStufe = z1;
        let opt = uidListe.options() & ~3 & 0xFF;
        if (h.tonStufe === h.TON_AUS) opt |= 1;
        else if (h.tonStufe === h.TON_LEISE) opt |= 2;
        uidListe.setOptions(opt);
        this.adminOk(cmd, z1, -1);
        return;
      }
      if (cmd === 'CARD') {
        // Genau derselbe Weg wie nach einem echten Scan.
        ({ size, uid } = AdminProtocol.adminUidLesen(a1));
        if (!size) { this.adminFehler('CARD <uid 8/14/20 hex>'); return; }
        h.legeKarteAuf(uid, size);
        S.println('#OK CARD');
        return;
      }
      if (cmd === 'WIPE') {
        if (!a1 || a1 !== 'JA') { this.adminFehler('WIPE JA'); return; }
        if (h.spielAktiv) h.beendeSitzung(true);
        uidListe.wipe();
        const ok = uidListe.begin();
        h.tonStufe = h.TON_LAUT;
        S.println(ok ? '#OK WIPE' : '#ERR WIPE');
        return;
      }
      this.adminFehler('PING LIST SET STAKE FLAG ADD FREE CARD SOUND WIPE');
    }
  }

  MC.AdminProtocol = AdminProtocol;
})();
