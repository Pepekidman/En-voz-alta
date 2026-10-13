# Estudio previo: apps similares y viabilidad técnica

Resumen del estudio hecho antes de programar (octubre 2026).

## Apps analizadas

Speechify (SP), Voice Dream Reader (VD), @Voice Aloud Reader (AV), NaturalReader (NR), ElevenReader (ER), Moon+ Reader (MR) y Google Play Libros (GPB).

| Función | Apps que la tienen | En Voz Alta |
|---|---|---|
| PDF / EPUB / TXT | Todas | ✅ + DOCX, ODT, FB2, HTML, MD, RTF |
| Resaltado sincronizado | VD y NR (palabra + frase), ER, SP | ✅ Frase; palabra exacta en iOS/escritorio, estimada en Android |
| Control de velocidad | Todas (SP hasta 4.5×) | ✅ 0.5×–3× |
| Saltos por frase / párrafo / capítulo | VD (unidad configurable) | ✅ |
| Temporizador de sueño | SP, VD, AV, NR, ER, MR | ✅ Minutos o fin de capítulo |
| Marcadores con notas | VD, ER, AV, MR, GPB | ✅ Exportables |
| Limpieza de encabezados y pies de PDF | VD, SP, NR, ER | ✅ Automática y desactivable |
| Diccionario de pronunciación | VD, AV (regex), NR | ✅ Con regex |
| Controles en pantalla de bloqueo | Todas | ✅ (Media Session) |
| Funciona sin conexión | VD, AV, MR (con voces del sistema) | ✅ |
| Exportar a MP3 | SP, AV, NR | ❌ No es posible con las voces del sistema en la web |
| OCR de escaneados | VD, AV, NR, SP | ❌ (pendiente) |

Lo que se vio:
- Las voces premium de SP, ER y NR funcionan en la nube.
- Una app offline compite con VD y @Voice, que usan las voces del sistema y ofrecen buen control del texto.

## Decisión técnica

- **PWA en GitHub Pages:**
  - No necesita tienda ni SDK, y se instala desde Chrome o Safari.
  - Funciona sin conexión gracias al service worker.
  - pdf.js y JSZip están incluidos en el repositorio.
- **Voces:** Web Speech API (voces del sistema).

Limitaciones de `speechSynthesis` en Chrome Android y cómo se resuelven:
- **No informa la palabra que se está leyendo** (evento `boundary`). Se resalta la frase completa, con un modo «palabra estimada».
- **`pause()` equivale a `cancel()`.** Pausar guarda la frase actual y reanudar vuelve a empezar esa frase.
- **Los textos largos fallan.** Se envía una frase por vez, de 220 caracteres como máximo.
- **El sistema no muestra controles con la pantalla bloqueada.** Se reproduce un audio silencioso en bucle y se usa Media Session.

**Próximo paso posible:**
- Voces neuronales offline con Piper o sherpa-onnx (WASM, unos 63 MB por voz en español: es_ES davefx/sharvard, es_MX ald/claude, es_AR daniela).
- Producen audio real: permiten exportar a MP3 y leer con la pantalla apagada de forma fiable.
- kokoro-js no sirve para español: solo pasa a fonemas en inglés.
