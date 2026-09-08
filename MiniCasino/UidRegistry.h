#ifndef MINI_CASINO_UID_REGISTRY_H
#define MINI_CASINO_UID_REGISTRY_H
#include <stdint.h>

// Tests fuehren dieselben Methoden zur Compilezeit mit einem EEPROM-Modell aus.
#ifdef UID_REGISTRY_CONSTEXPR_TEST
#define UID_FN constexpr
#else
#define UID_FN
#endif

namespace Casino {
// Format 07: 16 Byte Header + 32 Byte je Konto, also 31 Konten im 1-KiB-EEPROM.
// Eintrag = 16 Byte Identitaet (unveraendert aus Format 06: Marker, Laenge,
// UID[10], CRC[2], Status, Formatversion) und danach zwei 8-Byte-Kontokopien.
// Kontokopie: Sequenz, Guthaben[4], Einsatz, CRC[2] ueber die ersten 6 Bytes.
// Der Einsatz steht als Vielfaches von zehn Punkten drin, 0 = Standard.
//
// Guthaben liegen hier und nicht mehr auf der Karte. Geschrieben wird immer in
// die aeltere der beiden Kopien, Sequenz zuerst und CRC zuletzt. Ein Abbruch
// mittendrin laesst die andere Kopie unberuehrt; ein Konto geht nie verloren.
// Einzige Ausnahme ist die allererste Gutschrift, solange noch keine gueltige
// Kopie existiert. Sie faellt im Zweifel aus und wird nicht heimlich ersetzt.
//
// Vor der ersten Gutschrift reservieren. Unklare Versuche bleiben gesperrt,
// damit eine UID niemals ein zweites Startguthaben erzeugt.
template<class Storage> class UidRegistry {
  Storage &memory;
  bool ready;

  enum { EINTRAG = 32, KONTO_A = 16, KONTO_B = 24, KOPIE = 8 };
  // Statusbyte des Eintrags. Es liegt bewusst ausserhalb der Identitaets-CRC,
  // damit es ohne Neuberechnung gesetzt werden kann. Die Werte sind weit
  // auseinander gewaehlt, damit ein gekipptes Bit keinen anderen Zustand ergibt.
  enum { ST_RESERVIERT = 0x5A, ST_NORMAL = 0xA5, ST_GESPERRT = 0xB4, ST_ADMIN = 0xC3 };
  UID_FN bool bekannterStatus(uint8_t st) {
    return st == ST_RESERVIERT || st == ST_NORMAL || st == ST_GESPERRT || st == ST_ADMIN;
  }

  UID_FN int adresse(int slot) { return 16 + slot * EINTRAG; }
  UID_FN bool blank(int address, int count) {
    bool zeros = true, erased = true;
    for (int i = 0; i < count; ++i) {
      uint8_t b = memory.read(address + i);
      zeros = zeros && b == 0;
      erased = erased && b == 0xFF;
    }
    return zeros || erased;
  }
  UID_FN uint16_t crc16(int address, int count) {
    uint16_t crc = 0xFFFF;
    for (int i = 0; i < count; ++i) {
      crc ^= (uint16_t)memory.read(address + i) << 8;
      for (int b = 0; b < 8; ++b)
        crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
    }
    return crc;
  }
  // Identitaets-CRC: Laenge und UID. Status und Formatversion stehen bewusst
  // ausserhalb, damit confirm() sie ohne Neuberechnung setzen kann.
  UID_FN uint16_t checksum(int address) { return crc16(address + 1, 11); }
  UID_FN bool valid(int slot) {
    int a = adresse(slot);
    uint8_t n = memory.read(a + 1), state = memory.read(a + 14);
    return memory.read(a) == 0xC6 && (n == 4 || n == 7 || n == 10)
      && memory.read(a + 15) == 1 && bekannterStatus(state)
      && checksum(a) == ((uint16_t)memory.read(a + 12) | ((uint16_t)memory.read(a + 13) << 8));
  }

  // --- Kontokopien --------------------------------------------------------
  UID_FN bool kopieOk(int c) {
    return crc16(c, 6) == ((uint16_t)memory.read(c + 6) | ((uint16_t)memory.read(c + 7) << 8));
  }
  UID_FN uint8_t kopieSeq(int c) { return memory.read(c); }
  UID_FN uint8_t kopieEinsatz(int c) { return memory.read(c + 5); }
  UID_FN uint32_t kopieWert(int c) {
    uint32_t value = 0;
    for (int i = 0; i < 4; ++i) value |= (uint32_t)memory.read(c + 1 + i) << (8 * i);
    return value;
  }
  // Sequenz zuerst: ab dem ersten Byte passt die alte CRC nicht mehr. CRC
  // zuletzt: erst damit gilt die Kopie ueberhaupt als lesbar.
  UID_FN void kopieSchreiben(int c, uint8_t seq, uint32_t value, uint8_t einsatz) {
    memory.update(c, seq);
    for (int i = 0; i < 4; ++i) memory.update(c + 1 + i, (uint8_t)(value >> (8 * i)));
    memory.update(c + 5, einsatz);
    uint16_t crc = crc16(c, 6);
    memory.update(c + 6, (uint8_t)crc);
    memory.update(c + 7, (uint8_t)(crc >> 8));
  }
  // Gueltige Kopie mit der neueren Sequenz; -1, wenn keine lesbar ist.
  // Der Abstand wird als vorzeichenloser Ueberlauf gerechnet.
  UID_FN int aktuelleKopie(int slot) {
    int a = adresse(slot) + KONTO_A, b = adresse(slot) + KONTO_B;
    bool okA = kopieOk(a), okB = kopieOk(b);
    if (okA && okB) return (uint8_t)(kopieSeq(a) - kopieSeq(b)) < 128 ? a : b;
    if (okA) return a;
    if (okB) return b;
    return -1;
  }
public:
  UID_FN explicit UidRegistry(Storage &storage) : memory(storage), ready(false) {}
  UID_FN int capacity() { return (memory.length() - 16) / EINTRAG; }
  UID_FN bool begin() {
    ready = false;
    const uint8_t header[16] = {'M','C','U','I','D','0','7',1,0,0,0,0,0,0,0,0xA5};
    if (capacity() < 1) return false; // Vergleich ohne Vorzeichenmischung.
    // Byte 8..14 halten Einstellungen und bleiben beim Vergleich aussen vor,
    // sonst wuerde ein geaenderter Schalter den EEPROM als fremd erscheinen lassen.
    bool matches = true;
    for (int i = 0; i < 16; ++i)
      if (i < 8 || i == 15) matches = matches && memory.read(i) == header[i];
    if (!matches) {
      // Die eigene Vorgaengerliste Format 06 darf ersetzt werden: sie enthielt
      // ausschliesslich UIDs und keine Guthaben, es geht also nichts verloren.
      // Fremde oder unbekannte EEPROM-Daten bleiben weiterhin unangetastet.
      const uint8_t vorher[7] = {'M','C','U','I','D','0','6'};
      bool vorgaenger = true;
      for (int i = 0; i < 7; ++i) vorgaenger = vorgaenger && memory.read(i) == vorher[i];
      if (vorgaenger) wipe();
      else if (!blank(0, memory.length())) return false;
      for (int i = 0; i < 16; ++i) memory.update(i, header[i]);
      for (int i = 0; i < 16; ++i) if (memory.read(i) != header[i]) return false;
    }
    ready = true;
    return true;
  }
  // Gesamten Bereich verwerfen. Loescht auch alle Guthaben; nur fuer den
  // bewusst aktivierten Loeschmodus. begin() legt den Header danach neu an.
  UID_FN void wipe() {
    int bytes = memory.length(); // EEPROMClass liefert uint16_t.
    for (int i = 0; i < bytes; ++i) memory.update(i, 0);
    ready = false;
  }
  // >=0: reserviert/bekannt, -1: unbekannt, -2: EEPROM/Eintrag fehlerhaft.
  UID_FN int find(const uint8_t *uid, uint8_t size) {
    if (!ready || (size != 4 && size != 7 && size != 10)) return -2;
    bool damaged = false;
    for (int slot = 0; slot < capacity(); ++slot) {
      int a = adresse(slot);
      if (!blank(a, EINTRAG)) {
        if (!valid(slot)) {
          damaged = true;
        } else {
          bool same = memory.read(a + 1) == size;
          for (int i = 0; i < size; ++i) same = same && memory.read(a + 2 + i) == uid[i];
          if (same) return slot;
        }
      }
    }
    return damaged ? -2 : -1;
  }
  // Reservierung muss im EEPROM lesbar sein, BEVOR das Startguthaben gilt.
  UID_FN int reserve(const uint8_t *uid, uint8_t size) {
    int previous = find(uid, size);
    if (previous != -1) return previous;
    for (int slot = 0; slot < capacity(); ++slot) {
      int a = adresse(slot);
      if (blank(a, EINTRAG)) {
        memory.update(a, 0); // Ungueltig bis zum letzten Schreibschritt.
        memory.update(a + 1, size);
        for (int i = 0; i < 10; ++i) memory.update(a + 2 + i, i < size ? uid[i] : 0);
        uint16_t crc = checksum(a);
        memory.update(a + 12, (uint8_t)crc);
        memory.update(a + 13, (uint8_t)(crc >> 8));
        memory.update(a + 14, 0x5A); // Reserviert / Ausgang eventuell unklar.
        memory.update(a + 15, 1);
        memory.update(a, 0xC6); // Commit-Marker zuletzt.
        return valid(slot) && find(uid, size) == slot ? slot : -2;
      }
    }
    return -3; // Voll: nie alte Eintraege verdraengen.
  }
  // Kartenzustaende nach aussen: 0 normal, 1 gesperrt, 2 unbegrenzt (Admin).
  enum { NORMAL = 0, GESPERRT = 1, ADMIN = 2 };
  UID_FN bool confirmed(int slot) {
    if (slot < 0 || slot >= capacity() || !valid(slot)) return false;
    uint8_t st = memory.read(adresse(slot) + 14);
    return st == ST_NORMAL || st == ST_GESPERRT || st == ST_ADMIN;
  }
  UID_FN bool confirm(int slot) {
    if (slot < 0 || slot >= capacity() || !valid(slot)) return false;
    // Eine schon gesetzte Sperre oder Adminkennung nicht ueberschreiben.
    if (!confirmed(slot)) memory.update(adresse(slot) + 14, ST_NORMAL);
    return confirmed(slot);
  }
  UID_FN uint8_t flag(int slot) {
    if (!confirmed(slot)) return NORMAL;
    uint8_t st = memory.read(adresse(slot) + 14);
    return st == ST_GESPERRT ? GESPERRT : st == ST_ADMIN ? ADMIN : NORMAL;
  }
  UID_FN bool setFlag(int slot, uint8_t art) {
    if (!confirmed(slot) || art > ADMIN) return false;
    memory.update(adresse(slot) + 14,
                  art == GESPERRT ? ST_GESPERRT : art == ADMIN ? ST_ADMIN : ST_NORMAL);
    return flag(slot) == art;
  }
  UID_FN bool banned(int slot) { return flag(slot) == GESPERRT; }
  UID_FN bool unlimited(int slot) { return flag(slot) == ADMIN; }
  // Fuer die Verwaltung: belegter Eintrag mit UID. false, wenn frei/ungueltig.
  UID_FN bool entry(int slot, uint8_t *uid, uint8_t &size) {
    if (!ready || slot < 0 || slot >= capacity()) return false;
    int a = adresse(slot);
    if (blank(a, EINTRAG) || !valid(slot)) return false;
    size = memory.read(a + 1);
    for (int i = 0; i < size; ++i) uid[i] = memory.read(a + 2 + i);
    return true;
  }
  // Einen Eintrag vollstaendig freigeben. Nur fuer die Verwaltung gedacht:
  // Danach gilt die UID als unbekannt und bekommt wieder ein Startguthaben.
  UID_FN bool clearSlot(int slot) {
    if (!ready || slot < 0 || slot >= capacity()) return false;
    int a = adresse(slot);
    for (int i = 0; i < EINTRAG; ++i) memory.update(a + i, 0);
    return blank(a, EINTRAG);
  }
  // Einstellungen im Header, Bit 0 = Ton stumm. Ueberleben Reset und
  // Stromausfall und haben mit den Konten nichts zu tun.
  UID_FN uint8_t options() { return ready ? memory.read(8) : 0; }
  UID_FN bool setOptions(uint8_t value) {
    if (!ready) return false;
    memory.update(8, value);
    return memory.read(8) == value;
  }
  // Ein Konto existiert erst mit mindestens einer lesbaren Kopie.
  UID_FN bool funded(int slot) {
    return confirmed(slot) && aktuelleKopie(slot) >= 0;
  }
  // Nur nach funded() auswerten; ohne lesbare Kopie sind es 0 Punkte.
  UID_FN uint32_t balance(int slot) {
    if (!confirmed(slot)) return 0;
    int c = aktuelleKopie(slot);
    return c < 0 ? 0 : kopieWert(c);
  }
  // Einsatz des Kontos als Vielfaches von zehn Punkten; 0 heisst Standard.
  UID_FN uint8_t stakeUnits(int slot) {
    if (!confirmed(slot)) return 0;
    int c = aktuelleKopie(slot);
    return c < 0 ? 0 : kopieEinsatz(c);
  }
  // Schreibt in die jeweils aeltere Kopie und prueft das Ergebnis zurueck.
  UID_FN bool writeAccount(int slot, uint32_t value, uint8_t einsatz) {
    if (!confirmed(slot)) return false;
    int a = adresse(slot) + KONTO_A, b = adresse(slot) + KONTO_B;
    int current = aktuelleKopie(slot);
    uint8_t seq = current < 0 ? 1 : (uint8_t)(kopieSeq(current) + 1);
    int target = current == a ? b : a;
    kopieSchreiben(target, seq, value, einsatz);
    return aktuelleKopie(slot) == target && kopieWert(target) == value
      && kopieEinsatz(target) == einsatz;
  }
  UID_FN bool setBalance(int slot, uint32_t value) {
    return writeAccount(slot, value, stakeUnits(slot)); // Einsatz beibehalten.
  }
  UID_FN bool setStakeUnits(int slot, uint8_t einsatz) {
    if (!funded(slot)) return false;
    return writeAccount(slot, balance(slot), einsatz);
  }
};
}
#undef UID_FN
#endif
