#define CASINO_CONSTEXPR_TEST
#include "../MiniCasino/CardRecord.h"
#include "../MiniCasino/ButtonBank.h"

static_assert(Casino::canPlay(10) && !Casino::canPlay(9), "no overdraft");
static_assert(!Casino::canPlay(UINT32_MAX) && Casino::canPlay(UINT32_MAX - 10), "no overflow");
static_assert(Casino::settled(90, 0, 0) == 110, "double stake, not entire wallet");
static_assert(Casino::settled(90, 0, 1) == 90, "loss costs ten");
static_assert(Casino::settled(0, 2, 2) == 90 && Casino::settled(0, 2, 1) == 0, "last stake on green");
static_assert(!Casino::canPlay(UINT32_MAX - 79, 2) && Casino::canPlay(UINT32_MAX - 80, 2), "green overflow bound");
static_assert(!Casino::canSettle(UINT32_MAX, 1, 1), "invalid pending overflow rejected");
constexpr bool allColours() {
  for (int choice = 0; choice < 3; ++choice) {
    int wins = 0;
    for (int result = 0; result < 3; ++result) if (Casino::payout(choice, result) > 0) ++wins;
    if (wins != 1) return false;
  }
  return true;
}
constexpr bool recordsAndRecovery() {
  uint8_t data[16] = {};
  Casino::encodeRecord(data, 100);
  if (!Casino::validRecord(data) || Casino::pendingRecord(data) || data[14] != 0xA7 || data[15] != 0xC6) return false;
  Casino::encodePending(data, 90, 2, 2);
  if (!Casino::pendingRecord(data)) return false;
  uint32_t target = Casino::recordSettled(data);
  Casino::encodeRecord(data, target);
  if (target != 180 || !Casino::validRecord(data) || Casino::pendingRecord(data)) return false;
  data[5] ^= 1;
  if (Casino::validRecord(data)) return false;
  Casino::encodePending(data, 90, 3, 0);
  return !Casino::validRecord(data);
}
constexpr bool bounceHoldAndRelease() {
  Casino::ButtonBank keys;
  keys.reset(1, 0); // Held at boot must not play.
  if (keys.update(1, 100)) return false;
  keys.update(0, 110); keys.update(0, 150);
  keys.update(1, 160); keys.update(0, 165); keys.update(1, 170);
  if (keys.update(1, 190) || keys.update(1, 210) != 1 || keys.update(1, 1000)) return false;
  keys.update(0, 1010); keys.update(0, 1050);
  keys.update(3, 1060);
  if (keys.update(3, 1100)) return false; // Two keys rejected; release both first.
  keys.update(2, 1110);
  if (keys.update(2, 1150)) return false;
  keys.update(0, 1160); keys.update(0, 1200);
  keys.update(4, 1210);
  return keys.update(4, 1250) == 4;
}
static_assert(allColours(), "one winning outcome for each colour");
static_assert(recordsAndRecovery(), "v6 compatible, fixed pending result, crc validation");
static_assert(bounceHoldAndRelease(), "bounce, held key, multi-key and release interlock");
constexpr bool lossRecoveryAndInvalidPending() {
  uint8_t data[16] = {};
  Casino::encodePending(data, 0, 0, 2);
  if (!Casino::pendingRecord(data) || Casino::settled(Casino::recordBalance(data), data[10], data[11]) != 0) return false;
  Casino::encodeRecord(data, 0);
  if (!Casino::validRecord(data) || Casino::pendingRecord(data)) return false;
  Casino::encodePending(data, UINT32_MAX, 1, 1);
  if (Casino::validRecord(data)) return false;
  Casino::encodePending(data, 90, 1, 1);
  data[11] = 2; // Changed result without matching CRC must not be paid.
  return !Casino::validRecord(data);
}
constexpr bool buttonTimeWrap() {
  Casino::ButtonBank keys;
  keys.reset(0, UINT32_MAX - 10);
  if (keys.update(0, 30)) return false;
  keys.update(2, 40);
  return keys.update(2, 80) == 2;
}
static_assert(lossRecoveryAndInvalidPending(), "zero balance preserved, no repeated payout, damaged pending rejected");
static_assert(buttonTimeWrap(), "debounce survives millis rollover");
constexpr bool weightedDraw() {
  int counts[3] = {};
  for (int ticket = 0; ticket < 100; ++ticket) {
    uint8_t colour = Casino::colourForTicket(ticket);
    if (colour > 2) return false;
    ++counts[colour];
  }
  return counts[0] == 45 && counts[1] == 45 && counts[2] == 10
    && Casino::colourForTicket(100) == 3;
}
constexpr bool spinAlwaysLandsAndSlows() {
  for (int start = 0; start < 3; ++start) {
    for (int result = 0; result < 3; ++result) {
      uint8_t count = Casino::spinSteps(start, result);
      if (count < 24 || count > 26 || Casino::spinLed(start, count - 1) != result) return false;
      if (Casino::spinDelay(0, count) != 45 || Casino::spinDelay(count - 1, count) != 500) return false;
      for (int step = 1; step < count; ++step) {
        if (Casino::spinDelay(step, count) < Casino::spinDelay(step - 1, count)) return false;
        if (Casino::spinLed(start, step) != (Casino::spinLed(start, step - 1) + 1) % 3) return false;
      }
    }
  }
  return true;
}
static_assert(weightedDraw(), "Schwarz 45, Rot 45, Gruen 10 von 100 Losen");
static_assert(spinAlwaysLandsAndSlows(), "Alle Start-/Zielpaare: langsam werden, kein Sprung am Ende");
constexpr bool legacyPayoutAndFixedMultiplier() {
  uint8_t data[16] = {};
  Casino::encodePending(data, 90, 2, 2);
  if (!Casino::pendingRecord(data) || data[13] != 9 || Casino::recordSettled(data) != 180) return false;
  data[4] = 2; data[13] = 0; // Original open V7 round, even if its result is green.
  uint16_t crc = Casino::recordCrc(data);
  data[14] = (uint8_t)crc; data[15] = (uint8_t)(crc >> 8);
  if (!Casino::pendingRecord(data) || Casino::recordSettled(data) != 110) return false;
  data[4] = 3; data[13] = 8;
  crc = Casino::recordCrc(data);
  data[14] = (uint8_t)crc; data[15] = (uint8_t)(crc >> 8);
  return !Casino::validRecord(data);
}
static_assert(legacyPayoutAndFixedMultiplier(), "New green 90; existing V2 green still 20; invalid multiplier rejected");
static_assert(Casino::BLACK_PERCENT * Casino::payout(0,0) == Casino::GREEN_PERCENT * Casino::payout(2,2), "same expected return for all colours");

// V4: Einsatz bezahlt, Ergebnis fest, Farbwahl noch offen.
constexpr bool openChoiceRound() {
  uint8_t data[16] = {};
  Casino::encodeOpen(data, 90, 2);
  // Offen heisst offen: weder abgeschlossenes Guthaben noch buchbare Runde.
  if (!Casino::validRecord(data) || !Casino::openChoiceRecord(data)) return false;
  if (Casino::pendingRecord(data) || Casino::recordBalance(data) != 90) return false;
  // Ohne Wahl gibt es nie eine Auszahlung, auch nicht versehentlich.
  if (Casino::recordPayout(data) != 0 || Casino::recordSettled(data) != 90) return false;
  if (Casino::openResult(data) != 2) return false;
  // Der Uno haelt die Wahl; erst sie entscheidet den Endstand.
  if (Casino::settled(Casino::recordBalance(data), 2, Casino::openResult(data)) != 180) return false;
  if (Casino::settled(Casino::recordBalance(data), 0, Casino::openResult(data)) != 90) return false;
  // Ein abgeschlossener V1-Datensatz darf nie als offene Wahl gelten.
  Casino::encodeRecord(data, 90);
  if (Casino::openChoiceRecord(data)) return false;
  // Nachtraeglich veraendertes Ergebnis ohne passende CRC wird abgewiesen.
  Casino::encodeOpen(data, 90, 0);
  data[11] = 2;
  return !Casino::validRecord(data) && !Casino::openChoiceRecord(data);
}
// Ein eingetragener Farbindex macht aus V4 keine buchbare Runde.
constexpr bool openChoiceCannotCarryAChoice() {
  uint8_t data[16] = {};
  Casino::encodeOpen(data, 90, 1);
  data[10] = 1; // Waere ein Treffer, wenn V4 eine Wahl tragen duerfte.
  uint16_t crc = Casino::recordCrc(data);
  data[14] = (uint8_t)crc; data[15] = (uint8_t)(crc >> 8);
  return !Casino::validRecord(data) && !Casino::openChoiceRecord(data)
    && !Casino::pendingRecord(data);
}
static_assert(openChoiceRound(), "V4 traegt Einsatz und Ergebnis, zahlt aber ohne Wahl nichts aus");
static_assert(openChoiceCannotCarryAChoice(), "V4 mit eingetragener Wahl wird abgewiesen");

// Freier Einsatz: Auszahlung und Grenzen skalieren mit.
constexpr bool freeStake() {
  // Schwarz/Rot zahlen doppelt, Gruen neunfach - unabhaengig vom Einsatz.
  if (Casino::payout(0, 0, 50) != 100 || Casino::payout(2, 2, 50) != 450) return false;
  if (Casino::payout(0, 1, 50) != 0) return false;
  if (Casino::settled(200, 0, 0, 50) != 300 || Casino::settled(200, 0, 1, 50) != 200) return false;
  // Nie mehr setzen als vorhanden.
  if (Casino::canPlay(40, 0, 50) || !Casino::canPlay(50, 0, 50)) return false;
  // Grenzen des Einsatzes selbst.
  if (Casino::canPlay(10000, 0, 0) || Casino::canPlay(10000, 0, 5)) return false;
  if (!Casino::canPlay(10000, 0, Casino::STAKE_MAX)) return false;
  if (Casino::canPlay(10000, 0, Casino::STAKE_MAX + 10)) return false;
  // Ueberlauf bleibt ausgeschlossen, auch bei grossem Einsatz auf Gruen.
  if (Casino::canPlay(UINT32_MAX - 100, 2, 50)) return false;
  if (!Casino::canSettle(100, 2, 2, 50) || Casino::canSettle(UINT32_MAX - 100, 2, 2, 50)) return false;
  // Ohne Angabe gilt weiterhin der Standardeinsatz.
  return Casino::payout(0, 0) == 20 && Casino::payout(2, 2) == 90;
}
// stakeLimit rundet ab, deckelt und bleibt spielbar.
constexpr bool stakeLimits() {
  if (Casino::stakeLimit(0) != 10 || Casino::stakeLimit(5) != 10) return false;
  if (Casino::stakeLimit(95) != 90 || Casino::stakeLimit(100) != 100) return false;
  return Casino::stakeLimit(999999) == Casino::STAKE_MAX;
}
static_assert(freeStake(), "payout, limits and overflow scale with a free stake");
static_assert(stakeLimits(), "stake limit rounds down, caps and stays playable");
