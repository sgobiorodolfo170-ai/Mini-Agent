// Split extracted document text into embeddable chunks.
// Markdown headings define heading_path; paragraphs are merged up to maxLen with overlap.
function splitParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+\n/g, '\n').trim())
    .filter(Boolean)
}

function hardSplit(text, maxLen, overlap) {
  const out = []
  let i = 0
  while (i < text.length) {
    out.push(text.slice(i, i + maxLen))
    if (i + maxLen >= text.length) break
    i += maxLen - Math.min(overlap, maxLen - 1)
  }
  return out
}

function chunkSection(text, headingPath, { maxLen = 800, overlap = 120 }) {
  const paras = splitParagraphs(text)
  const blocks = []
  let cur = ''
  const flush = () => {
    const t = cur.trim()
    if (t) blocks.push({ text: t, headingPath })
    cur = ''
  }
  for (const p of paras) {
    if (p.length > maxLen) {
      flush()
      for (const piece of hardSplit(p, maxLen, overlap)) {
        blocks.push({ text: piece, headingPath })
      }
      continue
    }
    if (cur.length + p.length + 1 > maxLen) flush()
    cur = cur ? cur + '\n' + p : p
  }
  flush()
  return blocks
}

function chunkDocument(text, { maxLen = 800, overlap = 120 } = {}) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n')
  const sections = []
  let headingPath = []
  let buf = []
  const flushSection = () => {
    const t = buf.join('\n').trim()
    if (t) sections.push({ text: t, headingPath: headingPath.join(' > ') || null })
    buf = []
  }
  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/)
    if (m) {
      flushSection()
      const level = m[1].length
      headingPath = headingPath.slice(0, level - 1)
      headingPath[level - 1] = m[2].trim()
      buf.push(line)
    } else {
      buf.push(line)
    }
  }
  flushSection()
  if (!sections.length) sections.push({ text: String(text).trim(), headingPath: null })

  const chunks = []
  let seq = 0
  for (const s of sections) {
    for (const block of chunkSection(s.text, s.headingPath, { maxLen, overlap })) {
      chunks.push({ seq: seq++, text: block.text, headingPath: block.headingPath })
    }
  }
  return chunks
}

module.exports = { chunkDocument, splitParagraphs, hardSplit }
