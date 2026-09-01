#ifndef MINI_CASINO_EMPTY_REGION_H
#define MINI_CASINO_EMPTY_REGION_H

#include <stdint.h>

namespace Casino {
enum class Region : uint8_t { Occupied, Zero, EmptyNdef };

// C++11 constexpr erlaubt dieselbe Erkennung im Sketch und in static_assert-Tests.
constexpr bool allZero(const uint8_t *data, uint8_t i = 0) {
  return i == 16 ? true : (data[i] == 0 && allZero(data, i + 1));
}

// Eng begrenzte, vollstaendige leere NDEF-Strukturen ab dem ersten Nutzbyte.
// FE beendet den TLV-Strom. Bytes danach sind keine aktiven NDEF-Nutzdaten;
// bei der Uebernahme koennen diese Restbytes innerhalb der 16 Bytes ersetzt werden.
// Unbekannte TLVs, Nutzlast, weitere Records, fehlendes FE bleiben gesperrt.
constexpr bool emptyNdef(const uint8_t *d) {
  return d[0] == 0x03 && (
    (d[1] == 0x00 && d[2] == 0xFE) ||
    (d[1] == 0x03 && d[2] == 0xD0 && d[3] == 0 && d[4] == 0 && d[5] == 0xFE) ||
    (d[1] == 0x04 && d[2] == 0xD8 && d[3] == 0 && d[4] == 0 && d[5] == 0
                 && d[6] == 0xFE));
}

constexpr Region classify(const uint8_t *d) {
  return allZero(d) ? Region::Zero : (emptyNdef(d) ? Region::EmptyNdef : Region::Occupied);
}

// Der gueltige leere NDEF-Strom endet schon in Block 4. Restbytes in den
// Nachbarbloecken gehoeren nicht dazu und werden beim Schreiben von Block 4
// nicht beruehrt. Ohne NDEF-Struktur bleibt die strenge Nullbyte-Pruefung.
constexpr bool classicNeighbourAllowed(Region first, const uint8_t *neighbour) {
  return first == Region::EmptyNdef || (first == Region::Zero && allZero(neighbour));
}

// Type-2-Capability-Container: Mapping v1, mindestens 16 Nutzbytes,
// frei les-/schreibbar. Keine Schloss- oder Konfigurationsbytes veraendern.
constexpr bool writableType2(const uint8_t *cc) {
  return cc[0] == 0xE1 && (cc[1] >> 4) == 1 && cc[2] >= 2 && cc[3] == 0;
}
}
#endif
