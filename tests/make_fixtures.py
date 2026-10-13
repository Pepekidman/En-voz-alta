"""Genera archivos de prueba (EPUB, DOCX, ODT, FB2, TXT, MD, HTML) en tests/fixtures."""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'fixtures')
os.makedirs(OUT, exist_ok=True)

PARAS = [
    '—Hola —dijo el Sr. Pérez—. ¿Vienes al pueblo? —preguntó con calma.',
    'El Dr. García llegó a EE. UU. en 1990 y vivió allí muchos años; después volvió.',
    'Ver pág. 23, por ejemplo[1]. Fin del primer capítulo.',
]


def write_epub():
    path = os.path.join(OUT, 'prueba.epub')
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        z.writestr('META-INF/container.xml', '''<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>''')
        z.writestr('OEBPS/content.opf', '''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="id">prueba-1</dc:identifier>
    <dc:title>Libro de Prueba</dc:title>
    <dc:creator>Autora Ejemplo</dc:creator>
    <dc:language>es</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="c1" href="text/cap1.xhtml" media-type="application/xhtml+xml"/>
    <item id="c2" href="text/cap2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="c1"/><itemref idref="c2"/></spine>
</package>''')
        z.writestr('OEBPS/nav.xhtml', '''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>
<nav epub:type="toc"><ol>
  <li><a href="text/cap1.xhtml">Capítulo I</a></li>
  <li><a href="text/cap2.xhtml#s2">Capítulo II</a></li>
</ol></nav></body></html>''')
        body1 = ''.join(f'<p>{p}</p>' for p in PARAS)
        z.writestr('OEBPS/text/cap1.xhtml', f'''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cap 1</title></head><body>
<h1>Capítulo I</h1>{body1}<p>Una nota<sup><a href="#n1">1</a></sup> al pie.</p></body></html>''')
        z.writestr('OEBPS/text/cap2.xhtml', '''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Cap 2</title></head><body>
<p>Texto previo.</p><h1 id="s2">Capítulo II</h1><p>La segunda parte empieza aquí. Y termina pronto.</p></body></html>''')


def write_docx():
    path = os.path.join(OUT, 'prueba.docx')
    paras = ''.join(f'<w:p><w:r><w:t xml:space="preserve">{p}</w:t></w:r></w:p>' for p in PARAS)
    doc = f'''<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Introducción</w:t></w:r></w:p>
{paras}
<w:p><w:r><w:t xml:space="preserve">Texto con </w:t></w:r><w:r><w:t>dos partes.</w:t></w:r></w:p>
</w:body></w:document>'''
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>')
        z.writestr('word/document.xml', doc)
        z.writestr('docProps/core.xml', '''<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Documento Word</dc:title><dc:creator>Autor Word</dc:creator></cp:coreProperties>''')


def write_odt():
    path = os.path.join(OUT, 'prueba.odt')
    paras = ''.join(f'<text:p>{p}</text:p>' for p in PARAS)
    content = f'''<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0">
<office:body><office:text><text:h text:outline-level="1">Título ODT</text:h>{paras}
<text:p>Con nota<text:note><text:note-body><text:p>Nota que no se lee.</text:p></text:note-body></text:note> al final.</text:p>
</office:text></office:body></office:document-content>'''
    with zipfile.ZipFile(path, 'w') as z:
        z.writestr('mimetype', 'application/vnd.oasis.opendocument.text')
        z.writestr('content.xml', content)


def write_fb2():
    paras = ''.join(f'<p>{p}</p>' for p in PARAS)
    fb2 = f'''<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0"><description><title-info>
<author><first-name>Ana</first-name><last-name>Ruiz</last-name></author><book-title>Libro FB2</book-title><lang>es</lang>
</title-info></description><body><section><title><p>Capítulo 1</p></title>{paras}</section></body></FictionBook>'''
    open(os.path.join(OUT, 'prueba.fb2'), 'w', encoding='utf-8').write(fb2)


def write_text():
    txt = 'CAPÍTULO I\n\n' + '\n\n'.join(
        # Párrafos con cortes de línea duros y guion de corte
        p[:30] + '\n' + p[30:] for p in PARAS
    ) + '\n\nEsta línea tiene una pala-\nbra cortada.\n\nCAPÍTULO II\n\nOtro texto final.\n'
    open(os.path.join(OUT, 'prueba.txt'), 'w', encoding='utf-8').write(txt)
    # Latin-1 (Windows-1252)
    open(os.path.join(OUT, 'latin1.txt'), 'wb').write('Canción de añoranza. El niño comió.'.encode('cp1252'))
    md = '# Título Markdown\n\nUn párrafo con **negrita** y un [enlace](https://ejemplo.com).\n\n## Sección dos\n\n- Elemento uno.\n- Elemento dos.\n\n```\ncódigo\n```\n'
    open(os.path.join(OUT, 'prueba.md'), 'w', encoding='utf-8').write(md)
    html = '<!doctype html><html lang="es"><head><title>Página HTML</title><style>p{}</style></head><body><nav>Menú</nav><article><h1>Artículo</h1><p>Primer párrafo del artículo.</p><p>Segundo párrafo.<script>alert(1)</script></p></article></body></html>'
    open(os.path.join(OUT, 'prueba.html'), 'w', encoding='utf-8').write(html)


if __name__ == '__main__':
    write_epub()
    write_docx()
    write_odt()
    write_fb2()
    write_text()
    print('ok', sorted(os.listdir(OUT)))
