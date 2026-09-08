#ifndef CASINO_CARD_RECORD_H
#define CASINO_CARD_RECORD_H
#include <stdint.h>
#include "GameRules.h"
#ifdef CASINO_CONSTEXPR_TEST
#define CARD_FN constexpr
#else
#define CARD_FN inline
#endif
namespace Casino {
CARD_FN uint16_t recordCrc(const uint8_t *data) {
  uint16_t crc = 0xFFFF;
  for (int i = 0; i < 14; ++i) {
    crc ^= (uint16_t)data[i] << 8;
    for (int bit = 0; bit < 8; ++bit)
      crc = (crc & 0x8000) ? (uint16_t)((crc << 1) ^ 0x1021) : (uint16_t)(crc << 1);
  }
  return crc;
}
CARD_FN uint32_t recordBalance(const uint8_t *data) {
  uint32_t balance = 0;
  for (int i = 0; i < 4; ++i) balance |= (uint32_t)data[5 + i] << (8 * i);
  return balance;
}
// V2 retains its original 2x rule; V3 stores the chosen multiplier explicitly.
CARD_FN uint32_t recordPayout(const uint8_t *data) {
  return data[10] == data[11] ? STAKE * (data[4] == 2 ? 2 : data[13]) : 0;
}
CARD_FN uint32_t recordSettled(const uint8_t *data) {
  return recordBalance(data) + recordPayout(data);
}
CARD_FN bool validRecord(const uint8_t *data) {
  if (data[0] != 'M' || data[1] != 'C' || data[2] != 'A' || data[3] != 'S') return false;
  if (recordCrc(data) != ((uint16_t)data[14] | ((uint16_t)data[15] << 8))) return false;
  if (data[4] == 1) {
    for (int i = 9; i < 14; ++i) if (data[i] != 0) return false;
    return true;
  }
  // V4: Einsatz bezahlt, Ergebnis steht fest, Farbwahl noch offen.
  // data[10] == 3 ist kein gueltiger Farbindex, deshalb bleibt recordPayout() 0.
  if (data[4] == 4) {
    return data[9] == 1 && data[10] == 3 && data[11] < 3
      && data[12] == STAKE && data[13] == 0;
  }
  bool format = (data[4] == 2 && data[13] == 0)
    || (data[4] == 3 && data[13] == (data[10] == 2 ? 9 : 2));
  return format && data[9] == 1 && data[12] == STAKE
    && data[10] < 3 && data[11] < 3
    && recordBalance(data) <= UINT32_MAX - recordPayout(data);
}
CARD_FN bool pendingRecord(const uint8_t *data) {
  return validRecord(data) && (data[4] == 2 || data[4] == 3);
}
CARD_FN void encodeRecord(uint8_t *data, uint32_t balance) {
  for (int i = 0; i < 16; ++i) data[i] = 0;
  data[0] = 'M'; data[1] = 'C'; data[2] = 'A'; data[3] = 'S'; data[4] = 1;
  for (int i = 0; i < 4; ++i) data[5 + i] = (uint8_t)(balance >> (8 * i));
  uint16_t crc = recordCrc(data);
  data[14] = (uint8_t)crc; data[15] = (uint8_t)(crc >> 8);
}
// Nur V4: Der Uno haelt die Farbwahl im RAM, die Karte darf inzwischen weg.
CARD_FN bool openChoiceRecord(const uint8_t *data) {
  return validRecord(data) && data[4] == 4;
}
CARD_FN uint8_t openResult(const uint8_t *data) { return data[11]; }
CARD_FN void encodeOpen(uint8_t *data, uint32_t debited, uint8_t result) {
  encodeRecord(data, debited);
  data[4] = 4; data[9] = 1; data[10] = 3; data[11] = result;
  data[12] = (uint8_t)STAKE;
  uint16_t crc = recordCrc(data);
  data[14] = (uint8_t)crc; data[15] = (uint8_t)(crc >> 8);
}
CARD_FN void encodePending(uint8_t *data, uint32_t debited, uint8_t choice, uint8_t result) {
  encodeRecord(data, debited);
  data[4] = 3; data[9] = 1; data[10] = choice; data[11] = result;
  data[12] = (uint8_t)STAKE;
  data[13] = payoutMultiplier(choice);
  uint16_t crc = recordCrc(data);
  data[14] = (uint8_t)crc; data[15] = (uint8_t)(crc >> 8);
}
}
#undef CARD_FN
#endif
