import { describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import JSZip from 'jszip'

import { extractText } from '../../electron/main/rag/extract'

// jszip is a transitive dependency of mammoth — used here only to assemble a
// minimal but valid OOXML package for the .docx extraction path.
async function writeDocx(filePath, paragraphs) {
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`
  )
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`
  )
  const body = paragraphs.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join('')
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body}</w:body>
</w:document>`
  )
  fs.writeFileSync(filePath, await zip.generateAsync({ type: 'nodebuffer' }))
}

// Hand-assembled single-page PDF with a correct xref table; content is ASCII
// because the base-14 Helvetica font cannot render CJK glyphs.
function buildPdf(text) {
  const stream = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  ]
  let out = '%PDF-1.4\n'
  const offsets = []
  objs.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'))
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const startxref = Buffer.byteLength(out, 'latin1')
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${startxref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

function tmpFile(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-extract-'))
  return path.join(dir, name)
}

describe('extractText', () => {
  it('extracts utf8 text from .txt and .markdown', async () => {
    const p1 = tmpFile('a.txt')
    fs.writeFileSync(p1, 'hello 世界', 'utf8')
    expect(await extractText(p1)).toEqual({ text: 'hello 世界', mime: 'text/plain' })

    const p2 = tmpFile('b.markdown')
    fs.writeFileSync(p2, '# 标题\n正文', 'utf8')
    expect((await extractText(p2)).text).toContain('# 标题')
  })

  it('throws on unsupported extensions', async () => {
    const p = tmpFile('a.doc')
    fs.writeFileSync(p, 'x')
    await expect(extractText(p)).rejects.toThrow('不支持的文件类型: .doc')
  })

  it('extracts raw text from a real docx package', async () => {
    const p = tmpFile('a.docx')
    await writeDocx(p, ['你好 DOCX 提取', 'second paragraph'])
    const r = await extractText(p)
    expect(r.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document')
    expect(r.text).toContain('你好 DOCX 提取')
    expect(r.text).toContain('second paragraph')
  })

  it('extracts page text from a real pdf', async () => {
    const p = tmpFile('a.pdf')
    fs.writeFileSync(p, buildPdf('miniagent pdf extract test'))
    const r = await extractText(p)
    expect(r.mime).toBe('application/pdf')
    expect(r.text).toContain('miniagent pdf extract test')
  })
})
