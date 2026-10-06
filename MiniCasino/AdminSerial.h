#ifndef CASINO_ADMIN_SERIAL_H
#define CASINO_ADMIN_SERIAL_H
// Zeilenbasiertes Verwaltungsprotokoll auf derselben seriellen Schnittstelle.
//
// Antworten beginnen immer mit '#', die normalen Logzeilen mit '['. Ein Host
// filtert also einfach nach dem ersten Zeichen und kann den Diagnoselog
// unveraendert mitlaufen lassen.
//
// Befehle (Grossschreibung egal, mit Zeilenumbruch abschliessen):
//   PING                 Version, Plaetze, Belegung, Tonstufe
//   LIST                 je belegtem Platz eine #ROW-Zeile
//   SET <platz> <wert>   Guthaben setzen
//   STAKE <platz> <wert> Einsatz setzen, Vielfaches von 10
//   ADD <uidhex> <wert>  Unbekannte UID anlegen und gutschreiben
//   FLAG <platz> <0|1|2> 0 normal, 1 gesperrt, 2 unbegrenzt (Admin)
//   FREE <platz>         Platz freigeben; die UID gilt danach als unbekannt
//   SOUND <0|1|2>        0 laut, 1 leise, 2 aus
//   CARD <uidhex>        Auflegen einer Karte vortaeuschen
//   WIPE JA              Alles loeschen, UIDs und Guthaben
//
// Achtung: Wer hier schreiben darf, kann Guthaben frei vergeben. Das Protokoll
// hat bewusst keine Zugangskontrolle; wer am USB-Kabel haengt, ist Admin.
// Auf kleinen Flash getrimmt: eigener Zahlenleser statt strtoul/atoi, ein
// gemeinsamer Pfad fuer Antworten und kurze Fehlertexte.
#include <string.h>

const byte ADMIN_MAX = 48;
char adminZeile[ADMIN_MAX];
byte adminLen = 0;

void adminFehler(const __FlashStringHelper *grund) {
  Serial.print(F("#ERR "));
  Serial.println(grund);
}
// "#OK <befehl> <platz> <wert>"; wert < 0 laesst ihn weg.
void adminOk(const char *cmd, long platz, long wert) {
  Serial.print(F("#OK "));
  Serial.print(cmd);
  Serial.print(' ');
  Serial.print(platz);
  if (wert >= 0) { Serial.print(' '); Serial.print(wert); }
  Serial.println();
}
// Dezimalzahl ohne Vorzeichen. Fehlt sie oder steht Unsinn darin: -1.
long adminZahl(const char *text) {
  if (!text || !*text) return -1;
  long wert = 0;
  for (; *text; ++text) {
    if (*text < '0' || *text > '9' || wert > 99999999L) return -1;
    wert = wert * 10 + (*text - '0');
  }
  return wert;
}
uint8_t hexWert(char c) {
  if (c >= '0' && c <= '9') return (uint8_t)(c - '0');
  c = (char)(c | 0x20);   // Kleinbuchstabe
  return (c >= 'a' && c <= 'f') ? (uint8_t)(c - 'a' + 10) : 16;
}
// Hexpaare in Bytes wandeln. Liefert die Laenge (4, 7, 10) oder 0 bei Unsinn.
uint8_t adminUidLesen(const char *text, uint8_t *uid) {
  uint8_t n = 0;
  if (!text) return 0;
  while (text[0] && text[1]) {
    uint8_t hoch = hexWert(text[0]), tief = hexWert(text[1]);
    if (n >= 10 || hoch > 15 || tief > 15) return 0;
    uid[n++] = (uint8_t)((hoch << 4) | tief);
    text += 2;
  }
  if (text[0]) return 0; // Ungerade Anzahl Zeichen.
  return (n == 4 || n == 7 || n == 10) ? n : 0;
}

void adminBefehl(char *zeile) {
  char *cmd = strtok(zeile, " ");
  if (!cmd) return;
  for (char *p = cmd; *p; ++p) if (*p >= 'a' && *p <= 'z') *p = (char)(*p - 32);
  char *a1 = strtok(NULL, " "), *a2 = strtok(NULL, " ");
  long z1 = adminZahl(a1), z2 = adminZahl(a2);
  int slot = (int)z1;
  bool sitzungHier = spielAktiv && spielSlot == slot;
  uint8_t uid[10]; uint8_t size = 0;

  if (!strcmp(cmd, "PING")) {
    int belegt = 0;
    for (int s = 0; s < uidListe.capacity(); ++s) if (uidListe.entry(s, uid, size)) ++belegt;
    Serial.print(F("#OK PING v11 slots="));
    Serial.print(uidListe.capacity());
    Serial.print(F(" used="));
    Serial.print(belegt);
    Serial.print(F(" sound="));
    Serial.print(tonStufe);
    Serial.print(F(" session="));
    Serial.println(spielAktiv ? spielSlot : -1);
    return;
  }
  if (!strcmp(cmd, "LIST")) {
    int n = 0;
    for (int s = 0; s < uidListe.capacity(); ++s) {
      if (!uidListe.entry(s, uid, size)) continue;
      ++n;
      Serial.print(F("#ROW "));
      Serial.print(s);
      Serial.print(' ');
      for (uint8_t i = 0; i < size; ++i) {
        if (uid[i] < 0x10) Serial.print('0');
        Serial.print(uid[i], HEX);
      }
      Serial.print(' ');
      Serial.print(uidListe.funded(s) ? 1 : 0);
      Serial.print(' ');
      Serial.print((unsigned long)uidListe.balance(s));
      Serial.print(' ');
      uint8_t einheiten = uidListe.stakeUnits(s);
      Serial.print((unsigned long)(einheiten ? einheiten * Casino::STAKE_SCHRITT : Casino::STAKE));
      Serial.print(' ');
      Serial.println(uidListe.flag(s));
    }
    Serial.print(F("#OK LIST "));
    Serial.println(n);
    return;
  }
  if (!strcmp(cmd, "SET")) {
    if (z1 < 0 || z2 < 0) { adminFehler(F("SET <platz> <wert>")); return; }
    if (!uidListe.confirmed(slot)) { adminFehler(F("Platz nicht belegt")); return; }
    if (!uidListe.setBalance(slot, (uint32_t)z2)) { adminFehler(F("EEPROM-Fehler")); return; }
    // Eine laufende Sitzung auf diesem Platz sofort nachziehen.
    if (sitzungHier) { spielGuthaben = (uint32_t)z2; spielMenue(); }
    adminOk(cmd, slot, z2);
    return;
  }
  if (!strcmp(cmd, "STAKE")) {
    if (z1 < 0 || z2 < 0 || Casino::checkStake((uint32_t)z2, Casino::STAKE_MAX)) {
      adminFehler(F("STAKE <platz> <10..2550, 10er>"));
      return;
    }
    if (!uidListe.funded(slot)) { adminFehler(F("Platz ohne Konto")); return; }
    if (!uidListe.setStakeUnits(slot, (uint8_t)(z2 / Casino::STAKE_SCHRITT))) {
      adminFehler(F("EEPROM-Fehler"));
      return;
    }
    if (sitzungHier) { spielEinsatz = (uint32_t)z2; spielMenue(); }
    adminOk(cmd, slot, z2);
    return;
  }
  if (!strcmp(cmd, "FLAG")) {
    if (z1 < 0 || z2 < 0 || z2 > 2) { adminFehler(F("FLAG <platz> <0|1|2>")); return; }
    if (!uidListe.confirmed(slot)) { adminFehler(F("Platz nicht belegt")); return; }
    if (!uidListe.setFlag(slot, (uint8_t)z2)) { adminFehler(F("EEPROM-Fehler")); return; }
    // Sperre wirkt sofort, auch mitten in einer laufenden Sitzung.
    if (sitzungHier) {
      if (z2 == 1) beendeSitzung(true);
      else { spielUnbegrenzt = (z2 == 2); spielMenue(); }
    }
    adminOk(cmd, slot, z2);
    return;
  }
  if (!strcmp(cmd, "ADD")) {
    size = adminUidLesen(a1, uid);
    if (!size || z2 < 0) { adminFehler(F("ADD <uid 8/14/20 hex> <wert>")); return; }
    slot = uidListe.reserve(uid, size);
    if (slot < 0) { adminFehler(slot == -3 ? F("Liste voll") : F("Liste gesperrt")); return; }
    if (!uidListe.confirm(slot) || !uidListe.setBalance(slot, (uint32_t)z2)) {
      adminFehler(F("Angelegt, Gutschrift fehlt"));
      return;
    }
    adminOk(cmd, slot, z2);
    return;
  }
  if (!strcmp(cmd, "FREE")) {
    if (z1 < 0) { adminFehler(F("FREE <platz>")); return; }
    if (sitzungHier) beendeSitzung(true);
    if (!uidListe.clearSlot(slot)) { adminFehler(F("Nicht freigegeben")); return; }
    adminOk(cmd, slot, -1);
    return;
  }
  if (!strcmp(cmd, "SOUND")) {
    if (z1 < 0 || z1 > 2) { adminFehler(F("SOUND <0|1|2>")); return; }
    tonStufe = (byte)z1;
    uint8_t opt = (uint8_t)(uidListe.options() & ~3);
    if (tonStufe == TON_AUS) opt |= 1;
    else if (tonStufe == TON_LEISE) opt |= 2;
    uidListe.setOptions(opt);
    adminOk(cmd, z1, -1);
    return;
  }
  if (!strcmp(cmd, "CARD")) {
    // Genau derselbe Weg wie nach einem echten Scan. Gedacht fuer die
    // Simulation ohne RC522 und zum Testen ohne Karte in der Hand.
    size = adminUidLesen(a1, uid);
    if (!size) { adminFehler(F("CARD <uid 8/14/20 hex>")); return; }
    legeKarteAuf(uid, size);
    Serial.println(F("#OK CARD"));
    return;
  }
  if (!strcmp(cmd, "WIPE")) {
    if (!a1 || strcmp(a1, "JA")) { adminFehler(F("WIPE JA")); return; }
    if (spielAktiv) beendeSitzung(true);
    uidListe.wipe();
    bool ok = uidListe.begin();
    tonStufe = TON_LAUT;
    Serial.println(ok ? F("#OK WIPE") : F("#ERR WIPE"));
    return;
  }
  adminFehler(F("PING LIST SET STAKE FLAG ADD FREE CARD SOUND WIPE"));
}

// Nichtblockierend aus loop() aufrufen. Zeilen laenger als ADMIN_MAX werden
// abgeschnitten und dann als unbekannter Befehl abgewiesen.
void adminService() {
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      adminZeile[adminLen] = 0;
      if (adminLen) adminBefehl(adminZeile);
      adminLen = 0;
      continue;
    }
    if (adminLen < ADMIN_MAX - 1) adminZeile[adminLen++] = c;
  }
}
#endif
