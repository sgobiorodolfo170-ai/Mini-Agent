import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { upsertMemoryFile, readMemoryFile, parseSections } from '../../electron/main/agent/memory'

let dir

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-memory-'))
})

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('upsertMemoryFile', () => {
  it('creates, appends and updates sections (case-insensitive by name)', async () => {
    const p = path.join(dir, 'memory.md')
    expect(await upsertMemoryFile(p, '偏好', '喜欢中文回复')).toContain('已保存')
    expect(await upsertMemoryFile(p, '项目', 'miniagent 是 Electron 应用')).toContain('已保存')

    let text = fs.readFileSync(p, 'utf8')
    expect(parseSections(text).map((s) => s.name)).toEqual(['偏好', '项目'])

    expect(await upsertMemoryFile(p, '偏好', '喜欢简洁回复')).toContain('已更新')
    text = fs.readFileSync(p, 'utf8')
    const secs = parseSections(text)
    expect(secs).toHaveLength(2)
    expect(secs[0].body).toContain('简洁回复')
    expect(text).not.toContain('中文回复')
  })

  it('matches names case-insensitively on update', async () => {
    const p = path.join(dir, 'memory2.md')
    await upsertMemoryFile(p, 'Todo', 'first')
    expect(await upsertMemoryFile(p, 'todo', 'second')).toContain('已更新')
    const secs = parseSections(fs.readFileSync(p, 'utf8'))
    expect(secs).toHaveLength(1)
    expect(secs[0].body).toContain('second')
  })

  it('rejects empty names', async () => {
    await expect(upsertMemoryFile(path.join(dir, 'm3.md'), '  ', 'x')).rejects.toThrow(/名称/)
  })

  it('creates missing parent directories', async () => {
    const p = path.join(dir, 'deep', 'nest', 'memory.md')
    await upsertMemoryFile(p, 'a', 'b')
    expect(fs.readFileSync(p, 'utf8')).toContain('## a')
  })
})

describe('readMemoryFile', () => {
  it('returns empty string for missing files and truncates long content', () => {
    expect(readMemoryFile(path.join(dir, 'nope.md'))).toBe('')
    const p = path.join(dir, 'big.md')
    fs.writeFileSync(p, 'x'.repeat(100))
    expect(readMemoryFile(p, 10)).toBe('x'.repeat(10))
  })
})

describe('parseSections', () => {
  it('splits on ## headings only', () => {
    const secs = parseSections('# 标题\n## A\n内容A\n## B\n内容B\n普通文本')
    expect(secs.map((s) => s.name)).toEqual(['A', 'B'])
    expect(secs[0].body).toContain('内容A')
    expect(secs[1].body).toContain('普通文本')
  })
  it('returns empty for text without headings', () => {
    expect(parseSections('no headings here')).toEqual([])
  })
})
