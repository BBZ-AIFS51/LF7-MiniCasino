#define CASINO_CONSTEXPR_TEST
#include "../MiniCasino/GameSounds.h"

template<unsigned int N>
constexpr bool validSound(const Casino::SoundNote (&notes)[N]) {
  unsigned long duration = 0;
  for (unsigned int i = 0; i < N; ++i) {
    if (notes[i].hz < 31 || notes[i].hz > 8000 || notes[i].duration == 0) return false;
    duration += notes[i].duration + notes[i].gap;
  }
  return duration <= 3000;
}
static_assert(validSound(Casino::WIN_SOUND), "finite playable win jingle");
static_assert(validSound(Casino::LOSS_SOUND), "finite playable loss jingle");
static_assert(validSound(Casino::JACKPOT_SOUND), "finite playable jackpot jingle");
static_assert(Casino::effectForRound(true,90) == Casino::SoundEffect::Jackpot, "jackpot only for paid green win");
static_assert(Casino::effectForRound(false,0) == Casino::SoundEffect::Loss, "drawn green is not automatically a win");
static_assert(Casino::effectForRound(true,20) == Casino::SoundEffect::Win, "old green round retains normal paid win");

// Bei freiem Einsatz entscheidet die Farbe, nicht die Hoehe der Auszahlung.
static_assert(Casino::effectForChoice(true, 2) == Casino::SoundEffect::Jackpot, "Gruen-Treffer ist Jackpot");
static_assert(Casino::effectForChoice(true, 0) == Casino::SoundEffect::Win, "Schwarz-Treffer ist normaler Gewinn");
static_assert(Casino::effectForChoice(true, 1) == Casino::SoundEffect::Win, "Rot-Treffer ist normaler Gewinn");
static_assert(Casino::effectForChoice(false, 2) == Casino::SoundEffect::Loss, "Verlust bleibt Verlust");
