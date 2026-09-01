#include "../MiniCasino/EmptyRegion.h"
using Casino::Region;

constexpr uint8_t zero[16] = {};
// Originale Speicherauszuege aus dem Nutzerlog.
constexpr uint8_t erased[16] = {0x03,0,0xFE,0,0,0,0,0,0,0,0,0,0,0,0,0};
constexpr uint8_t emptyWithTail[16] = {
  0x03,0x04,0xD8,0,0,0,0xFE,0,0x6E,0x30,0x34,0x3A,0x39,0x46,0x3A,0x39};
constexpr uint8_t emptyNoId[16] = {0x03,0x03,0xD0,0,0,0xFE};
// Classic DF 51 AA 39 aus dem v2-Log: Anmeldung klappt, Block 4 ist NDEF-leer.
constexpr uint8_t classicEmpty[16] = {0x03,0x04,0xD8,0,0,0,0xFE,0,0,0,0,0,0,0,0,0};
// Restbytes in einem nicht beschriebenen Nachbarblock.
constexpr uint8_t neighbourTail[16] = {0x20,0x41,0x42,0x43,0xFE};
constexpr uint8_t textRecord[16] = {0x03,0x08,0xD1,0x01,0x04,0x54,0x02,0x65,0x6E,0x41,0xFE};
constexpr uint8_t badLength[16] = {0x03,0x05,0xD8,0,0,0,0xFE};
constexpr uint8_t payload[16] = {0x03,0x04,0xD8,0,1,0,0xFE};
constexpr uint8_t id[16] = {0x03,0x04,0xD8,0,0,1,0xFE};
constexpr uint8_t type[16] = {0x03,0x04,0xD8,1,0,0,0xFE};
constexpr uint8_t notEmptyTnf[16] = {0x03,0x04,0xD9,0,0,0,0xFE};
constexpr uint8_t noTerminator[16] = {0x03,0x00,0x00};
constexpr uint8_t moreTlv[16] = {0x03,0,0x03,0,0xFE};
constexpr uint8_t unknown[16] = {0xFD,0,0xFE};
constexpr uint8_t ff[16] = {0xFF};
constexpr uint8_t oldCasino[16] = {'M','C','A','S',1};
constexpr uint8_t partialWrite[16] = {0,0,0,0,1,100};
constexpr uint8_t cc[4] = {0xE1,0x10,0x12,0};
constexpr uint8_t locked[4] = {0xE1,0x10,0x12,0x0F};
constexpr uint8_t invalidCc[4] = {0,0x10,0x12,0};
constexpr uint8_t tinyCc[4] = {0xE1,0x10,1,0};
constexpr uint8_t unknownVersion[4] = {0xE1,0x20,0x12,0};

static_assert(Casino::classify(zero) == Region::Zero, "raw blank");
static_assert(Casino::classify(erased) == Region::EmptyNdef, "user erased tag");
static_assert(Casino::classify(emptyWithTail) == Region::EmptyNdef, "user empty record with stale tail");
static_assert(Casino::classify(emptyNoId) == Region::EmptyNdef, "empty record without ID field");
static_assert(Casino::classify(classicEmpty) == Region::EmptyNdef, "user Classic block 4 is NDEF-empty too");
static_assert(Casino::classify(textRecord) == Region::Occupied, "preserve real text");
static_assert(Casino::classify(badLength) == Region::Occupied, "reject wrong length");
static_assert(Casino::classify(payload) == Region::Occupied, "preserve payload");
static_assert(Casino::classify(id) == Region::Occupied, "preserve ID");
static_assert(Casino::classify(type) == Region::Occupied, "preserve type");
static_assert(Casino::classify(notEmptyTnf) == Region::Occupied, "only empty TNF");
static_assert(Casino::classify(noTerminator) == Region::Occupied, "require terminator");
static_assert(Casino::classify(moreTlv) == Region::Occupied, "no additional TLV");
static_assert(Casino::classify(unknown) == Region::Occupied, "preserve unknown TLV");
static_assert(Casino::classify(ff) == Region::Occupied, "not all FF is empty");
static_assert(Casino::classify(oldCasino) == Region::Occupied, "wallet handled only by wallet validator");
static_assert(Casino::classify(partialWrite) == Region::Occupied, "partial raw write not blank");
static_assert(Casino::writableType2(cc), "valid writable Type 2 CC");
static_assert(!Casino::writableType2(locked), "reject read-only CC");
static_assert(!Casino::writableType2(invalidCc), "require CC magic");
static_assert(!Casino::writableType2(tinyCc), "require enough memory");
static_assert(!Casino::writableType2(unknownVersion), "require mapping v1");
static_assert(Casino::classicNeighbourAllowed(Casino::classify(classicEmpty), neighbourTail),
              "empty Classic NDEF must not be blocked by untouched neighbour bytes");
static_assert(Casino::classicNeighbourAllowed(Region::EmptyNdef, zero), "empty NDEF with empty neighbour");
static_assert(Casino::classicNeighbourAllowed(Region::Zero, zero), "blank sector allowed");
static_assert(!Casino::classicNeighbourAllowed(Region::Zero, neighbourTail), "raw blank block still protects occupied sector");
static_assert(!Casino::classicNeighbourAllowed(Region::Occupied, zero), "occupied first block not allowed");
