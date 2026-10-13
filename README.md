# En Voz Alta

Lector de documentos en voz alta para el celular. Funciona **sin conexión**, se instala desde el navegador (sin tienda de apps) y convierte PDF, EPUB, TXT, DOCX y más en audio, con el texto resaltado mientras escuchas.

## Funciones

**Lectura**
- Formatos: **PDF** (con texto), **EPUB**, **TXT**, **DOCX**, **ODT**, **FB2**, **HTML**, **Markdown**, **RTF**. También puedes pegar texto.
- Resaltado de la frase que se está leyendo y, si el motor de voz lo permite, de la palabra. Hay un modo «estimado» para Android.
- El texto se desplaza solo para seguir la lectura. Si te desplazas a mano, aparece **«Volver a la lectura»**.
- Tocar cualquier frase lleva la lectura a ese punto.

**Control**
- Velocidad de **0.5× a 3×** (botones rápidos y ajuste fino), más el tono de la voz.
- Pausa y reanudación exactas: el progreso se guarda en cada frase y al cerrar la app. Al volver a abrir el libro sigue donde quedó.
- Saltos por frase y por párrafo, barra de posición, índice de capítulos (EPUB, PDF con marcadores, títulos detectados) e «Ir a página» en PDF.
- **Temporizador de sueño**: 5 a 90 minutos o «al final del capítulo». Siempre termina la frase antes de detenerse.
- Controles en la **pantalla de bloqueo y en los auriculares** (Media Session).
- Tiempo restante estimado del capítulo y del libro. La estimación se ajusta a la velocidad real de la voz.

**Sonido natural**
- Segmentación en frases que entiende las abreviaturas (Sr., Dra., pág., EE. UU., iniciales…) y los decimales.
- Pausas configurables entre párrafos, en los títulos y entre frases.
- Las rayas de diálogo (—), los incisos y los paréntesis se convierten en pausas. Las comillas y los símbolos que el motor leería en voz alta se eliminan.
- Se expanden las abreviaturas («Sr.» → señor, «p. ej.» → por ejemplo) y los números romanos («Capítulo IV» → Capítulo 4).
- Se omiten las llamadas de nota ([12], ¹) y las URL (se lee «enlace»).
- **Diccionario de pronunciación** propio, con expresiones regulares opcionales, para nombres propios y siglas.
- Limpieza de PDF: quita encabezados, pies y números de página repetidos, une las palabras cortadas con guion y reconstruye los párrafos.

**Biblioteca**
- Portadas, progreso, búsqueda, varios órdenes, renombrar, cambiar el idioma y exportar el texto.
- Marcadores con nota, que se pueden exportar.
- Búsqueda dentro del libro, sin distinguir tildes.
- Respaldo completo en un archivo (textos, progreso, marcadores, ajustes) para pasar la biblioteca a otro teléfono.
- **Compartir → En Voz Alta** desde otras apps de Android (Web Share Target).

**Apariencia**
- Temas claro, sepia, oscuro y negro (AMOLED).
- Tamaño de letra, interlineado, cuatro tipos de letra y texto justificado.

**Privacidad**
- Todo se procesa y se guarda en el dispositivo (IndexedDB). Ningún archivo se sube a internet.

## Instalar en el celular

1. Abre la dirección de la app (ver *Publicación* abajo) en **Chrome** (Android) o **Safari** (iPhone).
2. Instálala:
   - **Android:** menú ⋮ → *Instalar aplicación* (o el aviso «Instalar» dentro de la app).
   - **iPhone:** botón Compartir → *Agregar a inicio*.
3. Para que funcione **sin internet**, instala una voz en el sistema:
   - **Android:** Ajustes → Sistema → Idiomas → *Salida de texto a voz* → *Servicios de voz de Google* → ⚙️ → *Instalar datos de voz* → Español.
   - **iPhone:** Ajustes → Accesibilidad → Contenido leído → Voces → Español → descarga una voz «Mejorada».
4. En la app, toca **«Voz»** y elige una voz marcada como *sin conexión*.

## Publicación (GitHub Pages)

El workflow `.github/workflows/pages.yml` ejecuta las pruebas y publica la app con cada push a la rama principal del repositorio.

Configuración (solo una vez):
1. En GitHub: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
   - En el plan gratuito de GitHub, Pages solo funciona con repositorios **públicos** (Settings → General → Danger Zone → Change visibility). Con GitHub Pro también funciona con repositorios privados, pero el sitio publicado es público.
2. Vuelve a ejecutar el workflow (Actions → *Pruebas y publicación* → *Re-run*) o haz push a la rama principal. La app queda en `https://<usuario>.github.io/En-voz-alta/`.

Alternativa sin GitHub Pages: cualquier hosting estático con HTTPS (Netlify, Cloudflare Pages, Vercel). Basta con subir los archivos del repositorio tal cual.

Cada publicación cambia la versión de la caché del service worker. La app avisa con «Hay una versión nueva disponible» y no se recarga a mitad de una lectura.

## Desarrollo

No hay paso de compilación: es HTML, CSS y JavaScript (módulos ES) sin dependencias en tiempo de ejecución. pdf.js y JSZip están incluidos en `vendor/` para que funcionen sin conexión.

```bash
npm start            # servidor local en http://localhost:8080
npm test             # pruebas unitarias del procesamiento de texto
npm i && npx playwright install chromium
npm run test:e2e     # prueba completa en Chromium con un sintetizador simulado
```

`npm run test:e2e` importa todos los formatos de `tests/fixtures/` y además genera un PDF con encabezados y números de página. Después prueba la reproducción, la velocidad, la persistencia, los marcadores, la búsqueda, el temporizador, el diccionario, el respaldo y el funcionamiento sin conexión. Las capturas quedan en `tests/output/`.

### Estructura

| Archivo | Función |
|---|---|
| `index.html`, `css/styles.css` | Interfaz (biblioteca, lector, reproductor y hojas de opciones) |
| `js/app.js` | Controlador de la interfaz |
| `js/player.js` | Reproductor: cola de frases, pausas, velocidad, temporizador y progreso |
| `js/speech.js` | Envoltorio de la Web Speech API (voces del sistema) |
| `js/text.js` | Segmentación, limpieza y preparación del texto hablado |
| `js/parsers/` | Lectores de PDF, EPUB, DOCX, ODT, FB2, HTML, MD, RTF y TXT |
| `js/media.js` | Controles de la pantalla de bloqueo y pantalla encendida |
| `js/db.js` | Almacenamiento local (IndexedDB) |
| `sw.js`, `manifest.webmanifest` | Funcionamiento sin conexión, instalación y «Compartir con» |

## Limitaciones conocidas

- **Resaltado por palabra en Android:** Chrome no informa en qué palabra va la voz. Se resalta la frase completa, o la palabra de forma aproximada en el modo «Estimado». En iPhone y en el escritorio el resaltado por palabra es exacto.
- **Pantalla apagada:** la app reproduce un audio silencioso para que el sistema la trate como un reproductor. Aun así, que la voz continúe con la pantalla bloqueada depende del navegador y del teléfono. Si se corta, activa *Ajustes → Mantener la pantalla encendida*. En iPhone, Safari detiene la voz al bloquear la pantalla.
- **PDF escaneados** (solo imágenes): no tienen texto y no se pueden leer (no hay OCR).
- **Exportar a MP3:** la síntesis del sistema no permite grabar el audio.

## Próximos pasos posibles

- Voces neuronales opcionales (Piper/sherpa-onnx en WebAssembly, unos 60 MB por voz). Darían la misma calidad en todos los dispositivos, lectura fiable con la pantalla apagada y exportación a audio.
- Un APK para Android (TWA con Bubblewrap) generado desde GitHub Actions.
- OCR sin conexión para PDF escaneados.

## Licencias de terceros

- [pdf.js](https://github.com/mozilla/pdf.js) 6.3.289: Apache-2.0 (`vendor/pdfjs/LICENSE`).
- [JSZip](https://github.com/Stuk/jszip) 3.10.1: MIT/GPLv3 (`vendor/jszip/LICENSE.md`).
