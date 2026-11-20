import { describe, expect, it } from 'vitest'
import { embedTexts } from '../../electron/main/rag/extract-embed'
import { extractText } from '../../electron/main/rag/extract'
import fs from 'fs'
import os from 'os'
import path from 'path'

describe('embedTexts', () => {
  it('batches texts and returns vectors with stable dim', async () => {
    const calls = []
    const fetchImpl = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) })
      const input = JSON.parse(opts.body).input
      return {
        ok: true,
        json: async () => ({
          data: input.map((t, i) => ({ index: i, embedding: [t.length, 1] }))
        })
      }
    }
    const { vectors, dim } = await embedTexts(
      {
        baseUrl: 'https://x/v1',
        apiKey: 'sk',
        model: 'emb',
        texts: ['aaa', 'bb', 'c', 'dddd'],
        batchSize: 2
      },
      fetchImpl
    )
    expect(calls).toHaveLength(2)
    expect(calls[0].url).toBe('https://x/v1/embeddings')
    expect(calls[0].body.model).toBe('emb')
    expect(dim).toBe(2)
    expect(vectors).toHaveLength(4)
    expect(vectors[0][0]).toBe(3)
    expect(vectors[3][0]).toBe(4)
  })
  it('surfaces http errors', async () => {
    const fetchImpl = async () => ({ ok: false, status: 429, text: async () => 'rate limited' })
    await expect(
      embedTexts({ baseUrl: 'https://x/v1', apiKey: 'sk', model: 'emb', texts: ['a'] }, fetchImpl)
    ).rejects.toThrow(/429/)
  })
})

describe('extractText', () => {
  it('reads md/txt files directly', async () => {
    const file = path.join(os.tmpdir(), `miniagent-md-${Date.now()}.md`)
    fs.writeFileSync(file, '# 标题\n\n正文')
    const r = await extractText(file)
    expect(r.text).toContain('正文')
    fs.rmSync(file, { force: true })
  })
  it('rejects unsupported types', async () => {
    await expect(extractText('C:\\x.exe')).rejects.toThrow(/不支持/)
  })
})
