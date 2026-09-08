#define UID_REGISTRY_CONSTEXPR_TEST
#include "../MiniCasino/UidRegistry.h"

struct Memory {
  uint8_t data[112]; // 16 Byte Header + 3 Eintraege a 32 Byte.
  int writes;
  int budget;
  constexpr Memory() : data{}, writes(0), budget(1000) {}
  constexpr int length() { return 112; }
  constexpr uint8_t read(int i) { return data[i]; }
  constexpr void update(int i, uint8_t b) {
    if (data[i] != b && writes < budget) { data[i] = b; ++writes; }
  }
};
constexpr uint8_t a[4] = {1,2,3,4};
constexpr uint8_t b[4] = {1,2,3,5};
constexpr uint8_t c[7] = {1,2,3,4,0,0,0};
constexpr uint8_t d[10] = {1,2,3,4,5,6,7,8,9,10};

constexpr bool normalLifecycle() {
  Memory m;
  Casino::UidRegistry<Memory> r(m);
  if (!r.begin() || r.find(a,4) != -1 || r.capacity() != 3) return false;
  int slot = r.reserve(a,4);
  if (slot != 0 || r.confirmed(slot)) return false;
  Casino::UidRegistry<Memory> reboot(m);
  if (!reboot.begin() || reboot.find(a,4) != slot) return false; // Pending survives power cycle.
  if (!reboot.confirm(slot) || !reboot.confirmed(slot)) return false;
  int oldWrites = m.writes;
  if (reboot.reserve(a,4) != slot || !reboot.confirm(slot) || m.writes != oldWrites) return false;
  Casino::UidRegistry<Memory> thirdBoot(m);
  return thirdBoot.begin() && thirdBoot.find(a,4) == 0 && thirdBoot.confirmed(0);
}
constexpr bool fullAndDistinct() {
  Memory m;
  Casino::UidRegistry<Memory> r(m);
  return r.begin() && r.reserve(a,4) == 0 && r.reserve(b,4) == 1
    && r.reserve(c,7) == 2 && r.reserve(d,10) == -3 && r.find(a,4) == 0;
}
constexpr bool protectsUnknownMemory() {
  Memory m;
  m.data[42] = 0x17;
  Casino::UidRegistry<Memory> r(m);
  return !r.begin() && r.reserve(a,4) == -2 && m.data[42] == 0x17;
}
constexpr bool checksumFailsClosed() {
  Memory m;
  Casino::UidRegistry<Memory> r(m);
  if (!r.begin() || r.reserve(a,4) != 0) return false;
  m.data[18] ^= 1;
  return r.find(a,4) == -2 && r.reserve(a,4) == -2 && r.reserve(b,4) == -2;
}
constexpr bool interruptedCommit() {
  Memory m;
  Casino::UidRegistry<Memory> r(m);
  if (!r.begin()) return false;
  m.budget = m.writes + 5;
  if (r.reserve(a,4) != -2) return false;
  m.budget = 1000;
  Casino::UidRegistry<Memory> reboot(m);
  return reboot.begin() && reboot.reserve(a,4) == -2;
}
constexpr bool erasedAndLongUid() {
  Memory m;
  for (int i=0; i<112; ++i) m.data[i] = 0xFF;
  Casino::UidRegistry<Memory> r(m);
  return r.begin() && r.reserve(d,10) == 0 && r.reserve(a,3) == -2;
}
// Nachlade-Modus: wipe() verwirft die Liste, begin() legt den Header neu an.
constexpr bool wipeResetsRegistry() {
  Memory m;
  Casino::UidRegistry<Memory> r(m);
  if (!r.begin() || r.reserve(a,4) != 0 || !r.confirm(0)) return false;
  r.wipe();
  if (r.find(a,4) != -2) return false; // Nach wipe() erst wieder begin() noetig.
  Casino::UidRegistry<Memory> reboot(m);
  return reboot.begin() && reboot.find(a,4) == -1 && reboot.reserve(a,4) == 0
    && !reboot.confirmed(0);
}
static_assert(normalLifecycle(), "reserve before write, confirm, reboot, no duplicate writes");
static_assert(fullAndDistinct(), "distinct UID lengths, full registry never evicts");
static_assert(protectsUnknownMemory(), "unknown EEPROM is not erased");
static_assert(checksumFailsClosed(), "damaged registry must not refill");
static_assert(interruptedCommit(), "interrupted reservation must not permit a card write");
static_assert(erasedAndLongUid(), "factory blank EEPROM and ten-byte UIDs supported");
static_assert(wipeResetsRegistry(), "wipe clears the list and begin() re-initialises it");

// Ein frisch reservierter Eintrag hat noch kein Konto: 0 und nicht funded.
// Erst setBalance() legt eine lesbare Kopie an.
constexpr bool balanceStartsEmpty() {
  Memory m;
  Casino::UidRegistry<Memory> r(m);
  if (!r.begin() || r.reserve(a,4) != 0 || !r.confirm(0)) return false;
  if (r.funded(0) || r.balance(0) != 0) return false;
  if (!r.setBalance(0, 100) || !r.funded(0) || r.balance(0) != 100) return false;
  // Ohne bestaetigten Eintrag wird nie gebucht.
  return !r.setBalance(1, 50) && r.balance(1) == 0;
}
// Buchungen wechseln zwischen beiden Kopien und ueberleben den Neustart.
constexpr bool balanceAlternatesAndPersists() {
  Memory m;
  Casino::UidRegistry<Memory> r(m);
  if (!r.begin() || r.reserve(a,4) != 0 || !r.confirm(0)) return false;
  for (uint32_t v = 100; v > 0; v -= 10) if (!r.setBalance(0, v) || r.balance(0) != v) return false;
  if (!r.setBalance(0, 0) || r.balance(0) != 0 || !r.funded(0)) return false;
  Casino::UidRegistry<Memory> reboot(m);
  return reboot.begin() && reboot.find(a,4) == 0 && reboot.balance(0) == 0;
}
// Abbruch mitten in der Buchung: die andere Kopie bleibt unberuehrt, es steht
// also entweder der alte oder der neue Stand da, nie etwas dazwischen.
constexpr bool balanceSurvivesTornWrite() {
  for (int cut = 1; cut < 10; ++cut) {
    Memory m;
    Casino::UidRegistry<Memory> r(m);
    if (!r.begin() || r.reserve(a,4) != 0 || !r.confirm(0)) return false;
    if (!r.setBalance(0, 100) || !r.setBalance(0, 90)) return false;
    m.budget = m.writes + cut;
    r.setBalance(0, 12345); // Bricht mittendrin ab.
    m.budget = 1000;
    Casino::UidRegistry<Memory> reboot(m);
    if (!reboot.begin()) return false;
    uint32_t value = reboot.balance(0);
    if (value != 90 && value != 12345) return false;
    if (!reboot.funded(0)) return false;
  }
  return true;
}
// Konten verschiedener UIDs bleiben getrennt; volle Liste verdraengt nichts.
constexpr bool accountsStayApart() {
  Memory m;
  Casino::UidRegistry<Memory> r(m);
  if (!r.begin()) return false;
  if (r.reserve(a,4) != 0 || r.reserve(b,4) != 1 || r.reserve(c,7) != 2) return false;
  if (r.reserve(d,10) != -3) return false;
  for (int slot = 0; slot < 3; ++slot)
    if (!r.confirm(slot) || !r.setBalance(slot, 10u * (slot + 1))) return false;
  return r.balance(0) == 10 && r.balance(1) == 20 && r.balance(2) == 30
    && r.find(a,4) == 0 && r.find(b,4) == 1 && r.find(c,7) == 2;
}
static_assert(balanceStartsEmpty(), "reservation carries no balance until one is written");
static_assert(balanceAlternatesAndPersists(), "balances alternate copies and survive a reboot");
static_assert(balanceSurvivesTornWrite(), "interrupted booking keeps the previous balance");
static_assert(accountsStayApart(), "one account per UID, full registry never evicts");

// Die eigene Merkliste 06 wird beim Start auf 07 gehoben, fremde Daten nie.
constexpr bool upgradesOwnPredecessor() {
  Memory m;
  const uint8_t alt[16] = {'M','C','U','I','D','0','6',1,0,0,0,0,0,0,0,0xA5};
  for (int i = 0; i < 16; ++i) m.data[i] = alt[i];
  m.data[16] = 0xC6; m.data[17] = 4; // Rest eines alten 16-Byte-Eintrags.
  Casino::UidRegistry<Memory> r(m);
  if (!r.begin() || r.find(a,4) != -1) return false;
  if (r.reserve(a,4) != 0) return false;
  if (!r.confirm(0) || !r.setBalance(0, 100) || r.balance(0) != 100) return false;
  // Fremder Header mit gleicher Laenge bleibt gesperrt und unveraendert.
  Memory f;
  const uint8_t fremd[16] = {'X','Y','Z','0','1','2','3',1,0,0,0,0,0,0,0,0xA5};
  for (int i = 0; i < 16; ++i) f.data[i] = fremd[i];
  Casino::UidRegistry<Memory> g(f);
  if (g.begin()) return false;
  for (int i = 0; i < 16; ++i) if (f.data[i] != fremd[i]) return false;
  return true;
}
static_assert(upgradesOwnPredecessor(), "format 06 is upgraded, foreign data is never erased");

// Einstellungen ueberleben den Neustart und stoeren die Konten nicht.
constexpr bool optionsPersist() {
  Memory m;
  Casino::UidRegistry<Memory> r(m);
  if (!r.begin() || r.options() != 0) return false;
  if (r.reserve(a,4) != 0 || !r.confirm(0) || !r.setBalance(0, 100)) return false;
  if (!r.setOptions(1) || r.options() != 1) return false;
  Casino::UidRegistry<Memory> reboot(m);
  if (!reboot.begin() || reboot.options() != 1) return false;
  // Konto und UID bleiben davon voellig unberuehrt.
  return reboot.find(a,4) == 0 && reboot.balance(0) == 100 && reboot.funded(0);
}
static_assert(optionsPersist(), "settings survive a reboot without disturbing accounts");

// Verwaltung: Eintrag auslesen und gezielt freigeben.
constexpr bool adminReadAndClear() {
  Memory m;
  Casino::UidRegistry<Memory> r(m);
  if (!r.begin()) return false;
  if (r.reserve(a,4) != 0 || !r.confirm(0) || !r.setBalance(0, 70)) return false;
  if (r.reserve(c,7) != 1 || !r.confirm(1) || !r.setBalance(1, 30)) return false;
  uint8_t uid[10] = {}; uint8_t size = 0;
  if (!r.entry(0, uid, size) || size != 4) return false;
  if (uid[0] != 1 || uid[1] != 2 || uid[2] != 3 || uid[3] != 4) return false;
  if (r.entry(2, uid, size)) return false; // Freier Platz liefert nichts.
  // Freigeben trifft nur diesen Eintrag, der Nachbar bleibt unberuehrt.
  if (!r.clearSlot(0) || r.find(a,4) != -1 || r.funded(0)) return false;
  if (r.find(c,7) != 1 || r.balance(1) != 30) return false;
  // Der freie Platz wird danach normal wiederverwendet.
  return r.reserve(b,4) == 0 && r.confirm(0) && r.setBalance(0, 100)
    && r.balance(0) == 100 && r.balance(1) == 30;
}
static_assert(adminReadAndClear(), "admin can read an entry and free exactly one slot");

// Einsatz je Konto: bleibt beim Buchen erhalten und ueberlebt den Neustart.
constexpr bool stakePerAccount() {
  Memory m;
  Casino::UidRegistry<Memory> r(m);
  if (!r.begin() || r.reserve(a,4) != 0 || !r.confirm(0)) return false;
  if (!r.setBalance(0, 100) || r.stakeUnits(0) != 0) return false; // 0 = Standard
  if (!r.setStakeUnits(0, 5) || r.stakeUnits(0) != 5) return false;
  // Eine normale Buchung darf den Einsatz nicht verlieren.
  if (!r.setBalance(0, 250) || r.balance(0) != 250 || r.stakeUnits(0) != 5) return false;
  Casino::UidRegistry<Memory> reboot(m);
  if (!reboot.begin() || reboot.balance(0) != 250 || reboot.stakeUnits(0) != 5) return false;
  // Zweites Konto bleibt davon unberuehrt.
  if (reboot.reserve(b,4) != 1 || !reboot.confirm(1) || !reboot.setBalance(1, 40)) return false;
  return reboot.stakeUnits(1) == 0 && reboot.stakeUnits(0) == 5;
}
static_assert(stakePerAccount(), "per-account stake survives bookings and reboots");

// Sperre und Adminkennung: eigener Status, Konto bleibt unberuehrt.
constexpr bool cardFlags() {
  Memory m;
  Casino::UidRegistry<Memory> r(m);
  using Reg = Casino::UidRegistry<Memory>;
  if (!r.begin() || r.reserve(a,4) != 0 || !r.confirm(0) || !r.setBalance(0, 100)) return false;
  if (r.flag(0) != Reg::NORMAL || r.banned(0) || r.unlimited(0)) return false;
  // Sperren aendert weder Guthaben noch Einsatz noch die Auffindbarkeit.
  if (!r.setFlag(0, Reg::GESPERRT) || !r.banned(0) || r.unlimited(0)) return false;
  if (r.balance(0) != 100 || r.find(a,4) != 0 || !r.confirmed(0)) return false;
  // Buchungen funktionieren weiter, die Sperre bleibt erhalten.
  if (!r.setBalance(0, 55) || r.balance(0) != 55 || !r.banned(0)) return false;
  // Ueber einen Neustart hinweg.
  Casino::UidRegistry<Memory> reboot(m);
  if (!reboot.begin() || !reboot.banned(0)) return false;
  // confirm() darf eine bestehende Sperre nicht aufheben.
  if (!reboot.confirm(0) || !reboot.banned(0)) return false;
  if (!reboot.setFlag(0, Reg::ADMIN) || !reboot.unlimited(0) || reboot.banned(0)) return false;
  if (!reboot.setFlag(0, Reg::NORMAL) || reboot.flag(0) != Reg::NORMAL) return false;
  // Unbekannter Zustand und leerer Platz werden abgewiesen.
  return !reboot.setFlag(0, 3) && !reboot.setFlag(1, Reg::GESPERRT);
}
static_assert(cardFlags(), "ban and admin flags persist without touching the account");
