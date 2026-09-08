#ifndef CASINO_GAME_RULES_H
#define CASINO_GAME_RULES_H
#include <stdint.h>
namespace Casino {
constexpr uint32_t STAKE = 10;          // Standardeinsatz einer neuen Karte.
constexpr uint32_t STAKE_SCHRITT = 10;  // Einsaetze sind Vielfache davon.
constexpr uint32_t STAKE_MAX = 2550;    // Passt als Vielfaches in ein Byte.
constexpr uint8_t BLACK_PERCENT = 45;
constexpr uint8_t RED_PERCENT = 45;
constexpr uint8_t GREEN_PERCENT = 10;
static_assert(BLACK_PERCENT + RED_PERCENT + GREEN_PERCENT == 100, "Chancen muessen zusammen 100 ergeben");
static_assert(GREEN_PERCENT < BLACK_PERCENT && GREEN_PERCENT < RED_PERCENT, "Gruen hat die kleinste Chance");
// Input is uniformly drawn from 0..99. 3 denotes an invalid ticket.
constexpr uint8_t colourForTicket(uint8_t ticket) {
  return ticket >= 100 ? 3 : ticket < BLACK_PERCENT ? 0
    : ticket < BLACK_PERCENT + RED_PERCENT ? 1 : 2;
}
// Consecutive LEDs, 8+ turns, last LED always equals the already drawn result.
constexpr uint8_t spinSteps(uint8_t start, uint8_t result) {
  return 24 + (result + 4 - start) % 3;
}
constexpr uint8_t spinLed(uint8_t start, uint8_t step) {
  return (start + step) % 3;
}
constexpr uint16_t spinDelay(uint8_t step, uint8_t count) {
  return 45 + (455UL * step * step) / ((count - 1UL) * (count - 1UL));
}
constexpr uint8_t payoutMultiplier(uint8_t choice) {
  return choice >= 3 ? 0 : choice == 2 ? 9 : 2;
}
// Der Einsatz ist einstellbar; ohne Angabe gilt der Standardeinsatz.
constexpr bool canPlay(uint32_t balance, uint8_t choice = 0, uint32_t stake = STAKE) {
  return choice < 3 && stake >= STAKE_SCHRITT && stake <= STAKE_MAX && balance >= stake
    && balance <= UINT32_MAX - stake * (payoutMultiplier(choice) - 1);
}
constexpr uint32_t payout(uint8_t choice, uint8_t result, uint32_t stake = STAKE) {
  return choice < 3 && choice == result ? payoutMultiplier(choice) * stake : 0;
}
// Called only with a validated, already debited pending record.
constexpr bool canSettle(uint32_t debited, uint8_t choice, uint8_t result,
                         uint32_t stake = STAKE) {
  return choice < 3 && result < 3 && debited <= UINT32_MAX - payout(choice, result, stake);
}
constexpr uint32_t settled(uint32_t debited, uint8_t choice, uint8_t result,
                           uint32_t stake = STAKE) {
  return debited + payout(choice, result, stake);
}
// Groesster erlaubter Einsatz zu einem Guthaben, immer ein Vielfaches des
// Schritts und nie kleiner als ein Schritt.
constexpr uint32_t stakeLimit(uint32_t balance) {
  return balance < STAKE_SCHRITT ? STAKE_SCHRITT
    : ((balance < STAKE_MAX ? balance : STAKE_MAX) / STAKE_SCHRITT) * STAKE_SCHRITT;
}
}
#endif
