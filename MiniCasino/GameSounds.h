#ifndef CASINO_GAME_SOUNDS_H
#define CASINO_GAME_SOUNDS_H
#include <stdint.h>
#ifndef CASINO_CONSTEXPR_TEST
#include <avr/pgmspace.h>
#define SOUND_STORAGE PROGMEM
#else
#define SOUND_STORAGE
#endif

namespace Casino {
// Eigene kurze Meme-/Arcade-Tonfolgen, keine abgespielten Audioaufnahmen.
struct SoundNote { uint16_t hz; uint16_t duration; uint8_t gap; };
enum class SoundEffect : uint8_t { Win, Loss, Jackpot };
constexpr SoundEffect effectForRound(bool win, uint32_t payout) {
  return !win ? SoundEffect::Loss : payout == 90 ? SoundEffect::Jackpot : SoundEffect::Win;
}
// Bei freiem Einsatz sagt die Auszahlung nichts mehr ueber die Farbe aus:
// Jackpot ist ein Treffer auf Gruen, unabhaengig von der Hoehe.
constexpr SoundEffect effectForChoice(bool win, uint8_t choice) {
  return !win ? SoundEffect::Loss : choice == 2 ? SoundEffect::Jackpot : SoundEffect::Win;
}

// "Level up": schnelle aufsteigende Erfolgstoene.
constexpr SoundNote WIN_SOUND[] SOUND_STORAGE = {
  {1047,80,25}, {1319,80,25}, {1568,110,30}, {2093,230,60}
};
// "Womp womp": fallende Toene mit einer kurzen Pause.
constexpr SoundNote LOSS_SOUND[] SOUND_STORAGE = {
  {440,130,45}, {330,180,50}, {220,300,80}, {165,230,50}
};
// Jackpot: dreifacher Fanfaren-Auftakt und aufsteigender 8-Bit-Abschluss.
constexpr SoundNote JACKPOT_SOUND[] SOUND_STORAGE = {
  {784,90,30}, {1047,140,65}, {784,90,30}, {1047,140,65},
  {784,90,30}, {1568,250,90}, {1047,75,20}, {1319,75,20},
  {1568,75,20}, {2093,140,45}, {1568,100,30}, {2093,360,90}
};
}
#undef SOUND_STORAGE
#endif
