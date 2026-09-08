// Separater Tontest fuer den Arduino Uno.
// Testanschluss: D2 -> 330 Ohm -> S; Minus -> GND.
// Unbekannten mittleren Pin offen lassen. Kein Nachweis der Modul-Versorgung!
// Dieser Sketch ersetzt temporaer das Casino-Programm, aendert aber weder
// Kartenguthaben noch EEPROM. Danach wieder MiniCasino.ino hochladen.
#include <Arduino.h>

const byte BUZZER_PIN = 2;

void setup() {
  digitalWrite(BUZZER_PIN, LOW);
  pinMode(BUZZER_PIN, OUTPUT);
}

void loop() {
  tone(BUZZER_PIN, 1500, 250); // Tiefer
  delay(400);
  tone(BUZZER_PIN, 2000, 250); // Mittel
  delay(400);
  tone(BUZZER_PIN, 2500, 250); // Hoeher
  delay(400);
  noTone(BUZZER_PIN);
  digitalWrite(BUZZER_PIN, LOW);
  delay(2000);
}
