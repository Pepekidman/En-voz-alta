// Pruebas unitarias del procesamiento de texto: node --test tests/text.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  splitSentences, splitLong, toSpeech, romanToInt, detectLanguage, textToParagraphs,
  joinLines, cleanText, compileDictionary, looksLikeHeading, stripGutenbergBoilerplate
} from '../js/text.js';

const sentences = (t) => splitSentences(t).map((p) => t.slice(p.s, p.e).trim());

test('segmenta frases respetando abreviaturas e iniciales', () => {
  assert.deepEqual(sentences('El Sr. Pérez llegó. Luego se fue.'), ['El Sr. Pérez llegó.', 'Luego se fue.']);
  assert.deepEqual(sentences('J. R. R. Tolkien escribió. Fin.'), ['J. R. R. Tolkien escribió.', 'Fin.']);
  assert.deepEqual(sentences('Ver pág. 23 y p. ej. el cap. 4. Otra frase.'), ['Ver pág. 23 y p. ej. el cap. 4.', 'Otra frase.']);
  assert.deepEqual(sentences('Llegó a EE. UU. en 1990. Bien.'), ['Llegó a EE. UU. en 1990.', 'Bien.']);
});

test('no corta preguntas seguidas de minúscula ni decimales', () => {
  assert.deepEqual(sentences('¿Vienes? —preguntó María. Sí.'), ['¿Vienes? —preguntó María.', 'Sí.']);
  assert.deepEqual(sentences('Costó 3.5 millones. Caro.'), ['Costó 3.5 millones.', 'Caro.']);
  assert.deepEqual(sentences('¡Qué cosa! ¿Y ahora? Nada…'), ['¡Qué cosa!', '¿Y ahora?', 'Nada…']);
});

test('no confunde palabras comunes con abreviaturas', () => {
  assert.deepEqual(sentences('Dijo que no. Luego se fue.'), ['Dijo que no.', 'Luego se fue.']);
  assert.deepEqual(sentences('Miraba el mar. Era azul.'), ['Miraba el mar.', 'Era azul.']);
  assert.deepEqual(sentences('It happened two years ago. Then more.'), ['It happened two years ago.', 'Then more.']);
  assert.deepEqual(sentences('Según el art. 5 de la ley. Fin.'), ['Según el art. 5 de la ley.', 'Fin.']);
  assert.deepEqual(sentences('Tenía 5 años. 6 meses después volvió.'), ['Tenía 5 años.', '6 meses después volvió.']);
});

test('corta tras comillas y paréntesis de cierre', () => {
  assert.deepEqual(sentences('Dijo «basta.» Y se fue.'), ['Dijo «basta.»', 'Y se fue.']);
  assert.deepEqual(sentences('He said "stop." Then left.'), ['He said "stop."', 'Then left.']);
});

test('divide frases largas sin cortar palabras', () => {
  const long = 'Esta es una frase muy larga, con muchas comas, que sigue y sigue; tiene punto y coma, y continúa con más palabras para superar el límite establecido de caracteres por fragmento sin cortar palabras';
  const parts = splitLong(long, 80);
  assert.ok(parts.length >= 3);
  for (const p of parts) assert.ok(p.e - p.s <= 80);
  assert.equal(parts.map((p) => long.slice(p.s, p.e)).join(''), long);
  for (const p of parts.slice(1)) assert.ok(/\s/.test(long[p.s - 1]) || /[,;]/.test(long[p.s - 2]), 'corte en límite de palabra');
});

test('texto hablado: abreviaturas, rayas, comillas, notas y URLs', () => {
  assert.equal(toSpeech('—Hola —dijo el Sr. Pérez—.'), 'Hola, dijo el señor Pérez.');
  assert.equal(toSpeech('«No sé», respondió (en voz baja).'), 'No sé, respondió, en voz baja.');
  assert.equal(toSpeech('Nada más[12].'), 'Nada más.');
  assert.equal(toSpeech('Palabra¹ final.'), 'Palabra final.');
  assert.equal(toSpeech('Visita https://ejemplo.com/x hoy.'), 'Visita enlace hoy.');
  assert.equal(toSpeech('El Dr. García vive en EE. UU.'), 'El doctor García vive en Estados Unidos');
  assert.equal(toSpeech('Capítulo XII: El regreso'), 'Capítulo 12: El regreso');
  assert.equal(toSpeech('IV', { heading: true }), '4');
  assert.equal(toSpeech('Mi', { heading: true }), 'Mi');
  assert.equal(toSpeech('por otra parte mi padre llegó'), 'por otra parte mi padre llegó');
  assert.equal(toSpeech('In part I think so.', { lang: 'en' }), 'In part I think so.');
  assert.equal(toSpeech('Part II begins.', { lang: 'en' }), 'Part 2 begins.');
  assert.equal(toSpeech('No. That is false.', { lang: 'en' }), 'No. That is false.');
  assert.equal(toSpeech('Mr. Smith arrived.', { lang: 'en' }), 'Mister Smith arrived.');
  assert.equal(toSpeech('Pan & vino'), 'Pan y vino');
  assert.equal(toSpeech('It\'s John\'s book.', { lang: 'en' }), 'It\'s John\'s book.');
});

test('opciones del texto hablado se pueden desactivar', () => {
  assert.equal(toSpeech('El Sr. Pérez.', { expandAbbr: false }), 'El Sr. Pérez.');
  assert.equal(toSpeech('Ver [3].', { skipRefs: false }), 'Ver, 3.');
});

test('diccionario de pronunciación', () => {
  const dict = compileDictionary([
    { from: 'Hermione', to: 'Hermáioni' },
    { from: 'ONU', to: 'Naciones Unidas', caseSensitive: true },
    { from: '\\bcap\\.?\\s*(\\d+)', to: 'capítulo $1', regex: true },
    { from: 'ignorar', to: 'x', enabled: false },
    { from: '([', to: 'mal', regex: true }
  ]);
  assert.equal(dict.length, 3);
  assert.equal(toSpeech('Hermione y la ONU.', { dict }), 'Hermáioni y la Naciones Unidas.');
  assert.equal(toSpeech('la onu', { dict }), 'la onu');
  assert.equal(toSpeech('ver cap 7', { dict, expandAbbr: false }), 'ver capítulo 7');
});

test('números romanos', () => {
  assert.equal(romanToInt('IV'), 4);
  assert.equal(romanToInt('XLII'), 42);
  assert.equal(romanToInt('MCMXC'), 1990);
  assert.equal(romanToInt('IIII'), null);
  assert.equal(romanToInt('ABC'), null);
});

test('detecta el idioma', () => {
  assert.equal(detectLanguage('El perro de la casa se fue con los niños por el camino y no volvió nunca más.'), 'es');
  assert.equal(detectLanguage('The dog of the house went with the children and did not come back for a while.'), 'en');
  assert.equal(detectLanguage('O cão não voltou para casa com as crianças, e ela também não.'), 'pt');
  assert.equal(detectLanguage('hola'), null);
});

test('texto plano: párrafos, cortes de línea duros y títulos', () => {
  const t = 'CAPÍTULO I\n\nEra una vez una\nprinci-\npesa que vivía.\n\nOtro párrafo\naquí.\n';
  assert.deepEqual(textToParagraphs(t), [
    { t: 'h', x: 'CAPÍTULO I' },
    { t: 'p', x: 'Era una vez una principesa que vivía.' },
    { t: 'p', x: 'Otro párrafo aquí.' }
  ]);
  assert.deepEqual(textToParagraphs('Línea uno.\nLínea dos.\n'), [{ t: 'p', x: 'Línea uno.' }, { t: 'p', x: 'Línea dos.' }]);
});

test('utilidades de limpieza', () => {
  assert.equal(joinLines(['Bien-', 'venidos al', 'Norte-', 'Sur']), 'Bienvenidos al Norte- Sur');
  assert.equal(cleanText('ﬁn­al  de​ línea'), 'final de línea');
  assert.ok(looksLikeHeading('Capítulo 3'));
  assert.ok(looksLikeHeading('XIV'));
  assert.ok(!looksLikeHeading('Esto es una frase normal del texto.'));
  assert.ok(!looksLikeHeading('42'));
});

test('quita el encabezado y la licencia de Project Gutenberg', () => {
  const P = (x, t = 'p') => ({ t, x });
  const paras = [
    P('The Project Gutenberg eBook of Don Quijote'), P('This ebook is for the use of anyone anywhere...'),
    P('*** START OF THE PROJECT GUTENBERG EBOOK DON QUIJOTE ***'), P('Produced by Juan Pérez'),
    P('Capítulo primero', 'h'), P('En un lugar de la Mancha...'), P('Texto del libro.'),
    P('Capítulo segundo', 'h'), P('Más texto.'), P('Fin.'),
    P('*** END OF THE PROJECT GUTENBERG EBOOK DON QUIJOTE ***'), P('Updated editions will replace the previous one...'), P('License text')
  ];
  const chapters = [{ title: 'Capítulo primero', p: 4 }, { title: 'Capítulo segundo', p: 7 }, { title: 'License', p: 12 }];
  const r = stripGutenbergBoilerplate(paras, chapters);
  assert.deepEqual(r.paragraphs.map((p) => p.x), ['Capítulo primero', 'En un lugar de la Mancha...', 'Texto del libro.', 'Capítulo segundo', 'Más texto.', 'Fin.']);
  assert.deepEqual(r.chapters.map((c) => [c.title, c.p]), [['Capítulo primero', 0], ['Capítulo segundo', 3]]);
  const plain = [P('Uno.'), P('Dos.'), P('Tres.')];
  assert.equal(stripGutenbergBoilerplate(plain).paragraphs, plain);
});
