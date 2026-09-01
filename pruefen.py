"""Compile/link the sketch with the locally installed Arduino AVR toolchain.

No upload and no serial connection. Run: python pruefen.py
"""
from pathlib import Path
import os
import subprocess
import argparse

parser = argparse.ArgumentParser()
parser.add_argument('--sound', type=int, choices=(0, 1, 2), default=None,
                    help='Optionaler Override; ohne Argument gilt MiniCasino.ino')
parser.add_argument('--nachladen', type=int, choices=(0, 1), default=None,
                    help='Optionaler Override fuer den Nachlade-Modus')
parser.add_argument('--eeprom-loeschen', type=int, choices=(0, 1), default=None,
                    dest='eeprom_loeschen',
                    help='Optionaler Override fuer den EEPROM-Loeschmodus')
parser.add_argument('--sim', type=int, choices=(0, 1), default=None,
                    help='Simulationsbetrieb ohne RC522')
args = parser.parse_args()

root = Path(__file__).resolve().parent
arduino = Path(os.environ['LOCALAPPDATA']) / 'Arduino15'
avr = arduino / 'packages/arduino/hardware/avr/1.8.8'
bin_dir = arduino / 'packages/arduino/tools/avr-gcc/7.3.0-atmel3.6.1-arduino7/bin'
core = avr / 'cores/arduino'
libraries = [
    avr / 'libraries/SPI/src',
    avr / 'libraries/EEPROM/src',
    arduino / 'libraries/LiquidCrystal/src',
]  # MFRC522 liegt als Kopie im Sketch-Ordner und wird unten mitkompiliert.
build = root / '.build'
build.mkdir(exist_ok=True)
includes = [f'-I{p}' for p in [core, avr / 'variants/standard', *libraries]]
common = ['-mmcu=atmega328p', '-DF_CPU=16000000L', '-DARDUINO=10607',
          '-DARDUINO_AVR_UNO', '-DARDUINO_ARCH_AVR', '-Os', '-flto',
          '-ffunction-sections', '-fdata-sections', *includes]
if args.sound is not None:
    common += [f'-DCASINO_SOUND_MODE={args.sound}']
if args.nachladen is not None:
    common += [f'-DCASINO_NACHLADEN={args.nachladen}']
if args.eeprom_loeschen is not None:
    common += [f'-DCASINO_EEPROM_LOESCHEN={args.eeprom_loeschen}']
if args.sim is not None:
    common += [f'-DCASINO_SIM={args.sim}']

def run(args):
    subprocess.run([str(a) for a in args], check=True)

def compile_source(source, index):
    out = build / f'{index}.o'
    cpp = source.suffix in ('.cpp', '.ino')
    flags = ['-std=gnu++11', '-fpermissive', '-fno-exceptions',
             '-fno-threadsafe-statics'] if cpp else ['-std=gnu11']
    if source.suffix == '.S':
        flags = ['-x', 'assembler-with-cpp']
    if source.suffix == '.ino':
        flags += ['-x', 'c++', '-Wall', '-Wextra', f'-I{source.parent}']
    if source.name in ('uid_registry_test.cpp', 'game_test.cpp', 'sound_test.cpp'):
        flags += ['-std=gnu++14']
    run([bin_dir / ('avr-g++.exe' if cpp else 'avr-gcc.exe'),
         *common, *flags, '-c', source, '-o', out])
    return out

core_sources = sorted(p for p in core.iterdir() if p.suffix in ('.cpp', '.c', '.S'))
core_objects = [compile_source(p, f'core_{i}') for i, p in enumerate(core_sources)]
archive = build / 'core.a'
run([bin_dir / 'avr-gcc-ar.exe', 'rcs', archive, *core_objects])
sources = [root / 'MiniCasino/MiniCasino.ino']
sources += sorted((root / 'MiniCasino').glob('*.cpp'))
sources += sorted((root / 'tests').glob('*.cpp'))
for library in libraries:
    sources += sorted(p for p in library.rglob('*') if p.suffix in ('.cpp', '.c'))
objects = [compile_source(p, f'app_{i}') for i, p in enumerate(sources)]
elf = build / 'MiniCasino.elf'
run([bin_dir / 'avr-gcc.exe', '-mmcu=atmega328p', '-Os', '-flto',
     '-fuse-linker-plugin', '-Wl,--gc-sections', '-o', elf,
     *objects, archive, '-lm'])
run([bin_dir / 'avr-size.exe', '-C', '--mcu=atmega328p', elf])
print('UNO compile/link OK. Hardware has not been tested or flashed.')
print('Empty-region, UID registry, game/record recovery, button and sound checks passed.')
