# präsentation

10 minuten lf7-vortrag zum mini casino, felix und nikita. zwei versionen, gleicher inhalt, 16 folien.

| datei | was |
|---|---|
| `MiniCasino_Praesentation.pptx` | powerpoint mit sprechernotizen (sprecher und zeit pro folie) und 3d-standbildern |
| `index.html` | web-version: der 3d-viewer aus `case/viewer` läuft live mit kamerafahrten, live-demo mit großem oled, animiertes finale als lowpoly-casino-stadt |

## web-version starten

der browser sperrt den eingebetteten viewer, wenn man `index.html` per doppelklick öffnet. darum im hauptordner des repos einen kleinen server starten:

```bash
python -m http.server 8000
```

dann http://localhost:8000/praesentation/ öffnen. schriften und icons kommen von google fonts, jsdelivr und cdnjs, also internet einplanen.

## tasten

| taste | was |
|---|---|
| ← → leertaste | blättern |
| n | sprechernotizen mit uhr und zeitplan |
| f | vollbild |
| l | hell / dunkel, für helle räume |
| t | uhr auf den plan der aktuellen folie setzen |
| k, 1 2 3, a | nur auf der demo-folie: karte auflegen, farbe setzen, einsatz |

icons: [lucide](https://lucide.dev) (isc). 3d: three.js (mit).
