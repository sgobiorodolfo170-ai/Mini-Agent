const fs = require('fs')
const path = require('path')

// Extract plain text from supported document types: .md/.txt/.docx/.pdf
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  if (!['.md', '.markdown', '.txt', '.docx', '.pdf'].includes(ext)) {
    throw new Error(`不支持的文件类型: ${ext || '(无扩展名)'}`)
  }
  const buf = fs.readFileSync(filePath)
  if (ext === '.md' || ext === '.markdown' || ext === '.txt') {
    return { text: buf.toString('utf8'), mime: 'text/plain' }
  }
  if (ext === '.docx') {
    const mammoth = require('mammoth')
    const r = await mammoth.extractRawText({ buffer: buf })
    return {
      text: r.value || '',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    }
  }
  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
    try {
      const worker = await import('pdfjs-dist/legacy/build/pdf.worker.mjs')
      globalThis.pdfjsWorker = worker
    } catch {
      /* worker optional in node */
    }
    const doc = await pdfjs.getDocument({
      data: new Uint8Array(buf),
      isEvalSupported: false,
      useSystemFonts: false
    }).promise
    const pages = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      pages.push(tc.items.map((it) => it.str).join(' '))
      page.cleanup()
    }
    await doc.destroy()
    return { text: pages.join('\n\n'), mime: 'application/pdf' }
  }
  throw new Error(`不支持的文件类型: ${ext || '(无扩展名)'}`)
}

module.exports = { extractText }
