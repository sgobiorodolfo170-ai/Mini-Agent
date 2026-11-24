const fs = require('fs')
const path = require('path')

const TEXT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.vue',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.kt',
  '.kts',
  '.scala',
  '.sh',
  '.ps1',
  '.bat',
  '.cmd',
  '.sql',
  '.html',
  '.css',
  '.scss',
  '.less',
  '.json',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.xml',
  '.gradle',
  '.properties'
])

const TEXT_FILENAMES = new Set(['README', 'LICENSE', 'Dockerfile', 'Makefile'])

// Extract plain text from supported documents and source files.
async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  const plainText = TEXT_EXTENSIONS.has(ext) || TEXT_FILENAMES.has(path.basename(filePath))
  if (!plainText && !['.docx', '.pdf'].includes(ext)) {
    throw new Error(`不支持的文件类型: ${ext || '(无扩展名)'}`)
  }
  const buf = fs.readFileSync(filePath)
  if (plainText) {
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

module.exports = { extractText, TEXT_EXTENSIONS, TEXT_FILENAMES }
