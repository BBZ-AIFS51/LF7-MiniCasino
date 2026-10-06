// Hardwaretest fuer OLED-Bus, RC522 und 4x4-Tastatur, ohne Spiel.
// Braucht keine Bibliothek. Serieller Monitor auf 115200 Baud.
//
// OLED:     GND->GND, VCC->5V, SCL->A5, SDA->A4.
// RC522:    SDA->D10, SCK->D13, MOSI->D11, MISO->D12, RST->D9, 3.3V, GND.
// Tastatur: 8 Kabel der Reihe nach auf D3, D4, D5, D6, D7, D8, A0, A1.
//
// Erwartet im Monitor:
//   "I2C-Geraet auf 0x3C"  -> OLED antwortet (sonst SDA/SCL/VCC/GND pruefen)
//   "RC522 Version 0x88"   -> Reader antwortet (0x91/0x92 bei Originalen;
//                             0x00 oder 0xFF: Kabel, oft MOSI/MISO vertauscht)
//   "Taste: 1" usw.        -> bei jedem Druck genau die gedrueckte Taste.
//                             Kommt bei der 1 ein D, steckt der Stecker
//                             andersherum: REIHEN und SPALTEN tauschen, hier
//                             und in MiniCasino/GameRuntime.h.
// Ob das Display richtig zeichnet, zeigt der Hauptsketch selbst.
#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>

const byte REIHEN[4] = {A1, A0, 8, 7};   // Wie im Hauptsketch, am Aufbau getestet.
const byte SPALTEN[4] = {6, 5, 4, 3};
const char ZEICHEN[17] = "123A456B789C*0#D";

char taste() {
  for (byte r = 0; r < 4; ++r) {
    pinMode(REIHEN[r], OUTPUT);
    delayMicroseconds(10);
    for (byte s = 0; s < 4; ++s) {
      if (digitalRead(SPALTEN[s]) == LOW) {
        pinMode(REIHEN[r], INPUT);
        return ZEICHEN[r * 4 + s];
      }
    }
    pinMode(REIHEN[r], INPUT);
  }
  return 0;
}

byte rc522Version() {
  pinMode(10, OUTPUT); digitalWrite(10, HIGH);
  pinMode(9, OUTPUT); digitalWrite(9, LOW); delay(2);
  digitalWrite(9, HIGH); delay(50);
  SPI.begin();
  SPI.beginTransaction(SPISettings(1000000, MSBFIRST, SPI_MODE0));
  digitalWrite(10, LOW);
  SPI.transfer(0x80 | (0x37 << 1));
  byte version = SPI.transfer(0);
  digitalWrite(10, HIGH);
  SPI.endTransaction();
  return version;
}

void setup() {
  for (byte i = 0; i < 4; ++i) {
    pinMode(REIHEN[i], INPUT);
    digitalWrite(REIHEN[i], LOW);
    pinMode(SPALTEN[i], INPUT_PULLUP);
  }
  Serial.begin(115200);
  Wire.begin();
  byte gefunden = 0;
  for (byte adresse = 1; adresse < 127; ++adresse) {
    Wire.beginTransmission(adresse);
    if (Wire.endTransmission() == 0) {
      Serial.print(F("I2C-Geraet auf 0x"));
      Serial.println(adresse, HEX);
      ++gefunden;
    }
  }
  if (!gefunden) Serial.println(F("Kein I2C-Geraet! SDA/SCL vertauscht oder VCC/GND fehlt."));
  Serial.print(F("RC522 Version 0x"));
  Serial.println(rc522Version(), HEX);
  Serial.println(F("Jetzt Tasten druecken."));
}

char letzte = 0;
void loop() {
  char t = taste();
  if (t != letzte) {
    letzte = t;
    if (t) {
      Serial.print(F("Taste: "));
      Serial.println(t);
    }
  }
  delay(30);
}
