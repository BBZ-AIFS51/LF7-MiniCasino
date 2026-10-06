#ifndef CASINO_RC522_H
#define CASINO_RC522_H
#include <Arduino.h>
#include <string.h>

// Schlanker Treiber fuer den RC522, ersetzt die MFRC522-Bibliothek (spart rund
// 1,5 KB Flash). Er kann genau das, was das Casino braucht: eine Karte wecken
// (WUPA, weckt auch angehaltene Karten), ihre UID mit 4, 7 oder 10 Byte
// auswaehlen und sie wieder anhalten. Der Kartenspeicher wird nie gelesen.
// Liegen zwei Karten gleichzeitig auf, gilt das als Fehler; der naechste
// Versuch klappt, sobald nur noch eine im Feld ist.
//
// SPI laeuft direkt ueber die Register, ohne SPI-Bibliothek:
//   SDA/SS -> D10, MOSI -> D11, MISO -> D12, SCK -> D13, RST -> D9.
// Ablauf und Registerwerte folgen MFRC522 1.4.12 (Public Domain).
// Paare aus Register und Wert: Baudraten, Modulation, 25-ms-Timer, 100 % ASK,
// CRC-Startwert 0x6363, Empfangsverstaerkung 48 dB (RFCfgReg, untere Bits wie
// nach dem Reset). Die volle Verstaerkung bringt den Clone-Antennen Reichweite.
static const uint8_t RC522_INIT[] PROGMEM = {
  0x12, 0x00, 0x13, 0x00, 0x24, 0x26, 0x2A, 0x80, 0x2B, 0xA9,
  0x2C, 0x03, 0x2D, 0xE8, 0x15, 0x40, 0x11, 0x3D, 0x26, 0x78
};
class Rc522 {
public:
  struct Uid { uint8_t size; uint8_t uidByte[10]; uint8_t sak; };
  static const uint8_t OK = 0, TIMEOUT = 1, FEHLER = 2, KOLLISION = 3;
  Uid uid;

  // Hard-Reset, Grundeinstellung, volle Empfangsverstaerkung, Antenne an.
  void begin() {
    DDRB |= _BV(1) | _BV(2) | _BV(3) | _BV(5);   // RST, SS, MOSI, SCK als Ausgang
    PORTB |= _BV(2);                              // SS inaktiv
    SPCR = _BV(SPE) | _BV(MSTR);                  // SPI-Master, Modus 0, 4 MHz
    PORTB &= (uint8_t)~_BV(1);
    delay(2);
    PORTB |= _BV(1);
    delay(50);                                    // Oszillator anlaufen lassen
    for (uint8_t i = 0; i < sizeof(RC522_INIT); i += 2)
      schreibe(pgm_read_byte(RC522_INIT + i), pgm_read_byte(RC522_INIT + i + 1));
    antenne(true);
  }
  uint8_t version() { return lies(0x37); }
  void antenne(bool an) {
    uint8_t tx = lies(0x14);
    schreibe(0x14, an ? (uint8_t)(tx | 0x03) : (uint8_t)(tx & ~0x03));
  }

  // WUPA: liefert OK, wenn genau eine Karte mit 2 Byte ATQA antwortet.
  uint8_t wecken() {
    vorbereiten();
    uint8_t befehl = 0x52, antwort[2], n;
    uint8_t status = sende(&befehl, 1, antwort, 2, n, 7);
    if (status) return status;
    return (n == 2 && !letzteBits) ? OK : FEHLER;
  }

  // Anticollision und Select fuer bis zu drei Kaskadenstufen. Fuellt uid.
  uint8_t auswaehlen() {
    uint8_t puffer[9], antwort[5], pruef[2], n;
    uid.size = 0;
    vorbereiten();
    for (uint8_t stufe = 0; stufe < 3; ++stufe) {
      puffer[0] = (uint8_t)(0x93 + 2 * stufe);
      puffer[1] = 0x20;                           // Anticollision: UID erfragen
      uint8_t status = sende(puffer, 2, antwort, 5, n, 0);
      if (status) return status;
      if (n != 5 || (antwort[0] ^ antwort[1] ^ antwort[2] ^ antwort[3]) != antwort[4])
        return FEHLER;                            // BCC falsch
      puffer[1] = 0x70;                           // Select mit voller UID
      memcpy(puffer + 2, antwort, 5);
      if (!crc(puffer, 7, puffer + 7)) return FEHLER;
      status = sende(puffer, 9, antwort, 3, n, 0);
      if (status) return status;
      if (n != 3 || letzteBits || !crc(antwort, 1, pruef)
          || pruef[0] != antwort[1] || pruef[1] != antwort[2]) return FEHLER;
      if (!(antwort[0] & 0x04)) {                 // SAK: UID vollstaendig
        memcpy(uid.uidByte + uid.size, puffer + 2, 4);
        uid.size = (uint8_t)(uid.size + 4);
        uid.sak = antwort[0];
        return OK;
      }
      if (puffer[2] != 0x88) return FEHLER;       // Kaskaden-Tag fehlt
      memcpy(uid.uidByte + uid.size, puffer + 3, 3);
      uid.size = (uint8_t)(uid.size + 3);
    }
    return FEHLER;
  }

  // HLTA. Eine angehaltene Karte antwortet nicht, das Ausbleiben ist Erfolg.
  void anhalten() {
    uint8_t puffer[4] = {0x50, 0x00}, n;
    if (crc(puffer, 2, puffer + 2)) sende(puffer, 4, puffer, 0, n, 0);
  }

private:
  uint8_t letzteBits = 0;
  static uint8_t spi(uint8_t b) {
    SPDR = b;
    while (!(SPSR & _BV(SPIF))) {}
    return SPDR;
  }
  static uint8_t lies(uint8_t reg) {
    PORTB &= (uint8_t)~_BV(2);
    spi((uint8_t)(0x80 | (reg << 1)));
    uint8_t wert = spi(0);
    PORTB |= _BV(2);
    return wert;
  }
  static void schreibe(uint8_t reg, uint8_t wert) {
    PORTB &= (uint8_t)~_BV(2);
    spi((uint8_t)(reg << 1));
    spi(wert);
    PORTB |= _BV(2);
  }
  // Leerlauf, FIFO leeren und mit den Daten fuellen.
  static void fifo(const uint8_t *daten, uint8_t anzahl) {
    schreibe(0x01, 0x00);
    schreibe(0x0A, 0x80);
    for (uint8_t i = 0; i < anzahl; ++i) schreibe(0x09, daten[i]);
  }
  // Wie PICC_IsNewCardPresent: Standardbaudrate, Modulation, und nach einer
  // Kollision keine Bits weiterverwenden.
  static void vorbereiten() {
    schreibe(0x12, 0x00);
    schreibe(0x13, 0x00);
    schreibe(0x24, 0x26);
    schreibe(0x0E, (uint8_t)(lies(0x0E) & 0x7F));
  }

  // Senden und Antwort abholen. bits = gueltige Bits im letzten Byte (0 = 8).
  uint8_t sende(const uint8_t *daten, uint8_t anzahl, uint8_t *antwort,
                uint8_t max, uint8_t &n, uint8_t bits) {
    n = 0;
    schreibe(0x04, 0x7F);                         // Interrupts zuruecksetzen
    fifo(daten, anzahl);
    schreibe(0x0D, bits);
    schreibe(0x01, 0x0C);                         // Transceive
    schreibe(0x0D, (uint8_t)(bits | 0x80));       // Senden starten
    unsigned long seit = millis();
    for (;;) {
      uint8_t irq = lies(0x04);
      if (irq & 0x30) break;                      // Empfangen oder fertig
      if ((irq & 0x01) || millis() - seit > 36UL) return TIMEOUT;
    }
    uint8_t fehler = lies(0x06);
    if (fehler & 0x13) return FEHLER;             // Puffer, Paritaet, Protokoll
    n = lies(0x0A);
    if (n > max) return FEHLER;
    for (uint8_t i = 0; i < n; ++i) antwort[i] = lies(0x09);
    letzteBits = (uint8_t)(lies(0x0C) & 0x07);
    return (fehler & 0x08) ? KOLLISION : OK;
  }

  // CRC_A vom RC522 rechnen lassen, niedriges Byte zuerst.
  static bool crc(const uint8_t *daten, uint8_t anzahl, uint8_t *ergebnis) {
    schreibe(0x05, 0x04);
    fifo(daten, anzahl);
    schreibe(0x01, 0x03);                         // CalcCRC
    unsigned long seit = millis();
    while (!(lies(0x05) & 0x04))
      if (millis() - seit > 89UL) return false;
    schreibe(0x01, 0x00);
    ergebnis[0] = lies(0x22);
    ergebnis[1] = lies(0x21);
    return true;
  }
};
#endif
