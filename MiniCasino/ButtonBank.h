#ifndef CASINO_BUTTON_BANK_H
#define CASINO_BUTTON_BANK_H
#include <stdint.h>
#ifdef CASINO_CONSTEXPR_TEST
#define BUTTON_FN constexpr
#else
#define BUTTON_FN
#endif
namespace Casino {
// Input is a pressed-button bitmask. Only one fresh press after stable release.
class ButtonBank {
  uint8_t raw, stable;
  uint32_t changed;
  bool armed;
public:
  BUTTON_FN ButtonBank() : raw(0), stable(0), changed(0), armed(false) {}
  BUTTON_FN void reset(uint8_t mask, uint32_t now) {
    raw = stable = mask; changed = now; armed = false;
  }
  BUTTON_FN uint8_t update(uint8_t mask, uint32_t now) {
    if (mask != raw) { raw = mask; changed = now; }
    if ((uint32_t)(now - changed) < 35) return 0;
    if (mask == 0) { stable = 0; armed = true; return 0; }
    if (mask == stable) return 0;
    stable = mask;
    bool accept = armed;
    armed = false;
    return accept && (mask == 1 || mask == 2 || mask == 4) ? mask : 0;
  }
};
}
#undef BUTTON_FN
#endif
