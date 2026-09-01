#include <Arduino.h>
#include <LiquidCrystal.h>

// Arduino-Pins: RS=D8, E=D7, LCD-D4=D6, D5=D5, D6=D4, D7=D3.
LiquidCrystal lcd(8, 7, 6, 5, 4, 3);

void setup() {
  lcd.begin(16, 2);
  lcd.print("LCD funktioniert");
}

void loop() {
  lcd.setCursor(0, 1);
  lcd.print("Sek: ");
  lcd.print(millis() / 1000UL);
  delay(200);
}
