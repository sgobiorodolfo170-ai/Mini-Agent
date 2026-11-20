import { describe, expect, it } from 'vitest'
import { chunkDocument, hardSplit } from '../../electron/main/rag/chunk'

describe('hardSplit', () => {
  it('splits with overlap and covers the whole text', () => {
    const text = 'abcdefghij'.repeat(3) // 30 chars
    const pieces = hardSplit(text, 10, 3)
    expect(pieces[0]).toBe(text.slice(0, 10))
    // reconstruct coverage: each next piece overlaps previous tail
    let covered = pieces[0]
    for (const p of pieces.slice(1)) {
      const overlapLen = Math.min(p.length, covered.length)
      const tail = covered.slice(-overlapLen)
      const idx = p.indexOf(tail.slice(-Math.min(3, overlapLen)))
      covered += idx >= 0 ? p.slice(idx + Math.min(3, overlapLen)) : p
    }
    expect(covered).toBe(text)
  })
})

describe('chunkDocument', () => {
  it('tracks markdown heading path', () => {
    const md = ['# 指南\n\n正文段落一。\n\n## 安装\n\n安装说明。\n\n## 使用\n\n使用说明。']
    const chunks = chunkDocument(md[0], { maxLen: 100, overlap: 10 })
    expect(chunks.some((c) => c.headingPath === '指南')).toBe(true)
    expect(chunks.some((c) => c.headingPath === '指南 > 安装')).toBe(true)
    expect(chunks.some((c) => c.headingPath === '指南 > 使用')).toBe(true)
  })
  it('respects maxLen for oversized paragraphs', () => {
    const text = 'x'.repeat(2500)
    const chunks = chunkDocument(text, { maxLen: 800, overlap: 100 })
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(800)
    expect(chunks.length).toBeGreaterThan(1)
  })
  it('merges short paragraphs up to maxLen', () => {
    const text = Array.from({ length: 20 }, (_, i) => `段落${i}。`).join('\n\n')
    const chunks = chunkDocument(text, { maxLen: 800, overlap: 50 })
    expect(chunks.length).toBe(1)
  })
  it('assigns sequential seq numbers', () => {
    const md = '# A\n\n内容A。\n\n# B\n\n内容B。'
    const chunks = chunkDocument(md)
    chunks.forEach((c, i) => expect(c.seq).toBe(i))
  })
})
