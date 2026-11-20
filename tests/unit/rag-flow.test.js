import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import rag from '../../electron/main/rag/index'

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-rag-'))
}

function seedEmbedProvider() {
  const pid = repos.saveProvider(dbm.get(), { name: '嵌入', baseUrl: 'https://mock/v1' })
  repos.addKey(dbm.get(), { providerId: pid, label: '', secretEnc: 'plain:sk-e' })
  return pid
}

describe('RAG 导入 → 检索闭环', () => {
  it('导入 md 文档并向量检索命中', async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'a.md')
    fs.writeFileSync(file, '# 安装指南\n\n第一步：下载安装包。\n\n第二步：运行安装向导。')
    const pid = seedEmbedProvider()
    const kb = repos.createKb(dbm.get(), {
      name: '资料',
      embedProviderId: pid,
      embedModel: 'emb-1'
    })

    vi.stubGlobal('fetch', async (url, opts) => {
      const input = JSON.parse(opts.body).input
      // import 批量调用给 [1,0]，查询调用给近似向量 [0.95, 0.05]
      const vectors = input.map(() => (input.length === 1 ? [0.95, 0.05] : [1, 0]))
      return {
        ok: true,
        json: async () => ({ data: vectors.map((v, i) => ({ index: i, embedding: v })) })
      }
    })

    await rag.importDocs({ kbId: kb.id, paths: [file] })
    const docs = repos.listDocs(dbm.get(), kb.id)
    expect(docs).toHaveLength(1)
    expect(docs[0].status).toBe('ready')
    expect(docs[0].chunkCount).toBeGreaterThan(0)

    const result = await rag.searchKb(dbm.get(), kb, '安装指南', { k: 3 })
    expect(result.dim).toBe(2)
    expect(result.blocks).toHaveLength(1)
    expect(result.blocks[0].title).toBe('a.md')
    expect(result.blocks[0].score).toBeGreaterThan(0.9)
    expect(result.blocks[0].text).toContain('安装')

    // 重建索引：状态保持 ready，块数一致
    await rag.rebuildKb({ kbId: kb.id })
    const docs2 = repos.listDocs(dbm.get(), kb.id)
    expect(docs2[0].status).toBe('ready')
    expect(docs2[0].chunkCount).toBe(docs[0].chunkCount)

    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('重复导入相同内容按内容哈希去重', async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'b.txt')
    fs.writeFileSync(file, '普通文本内容，足够成块。')
    const pid = seedEmbedProvider()
    const kb = repos.createKb(dbm.get(), { name: '库', embedProviderId: pid, embedModel: 'emb' })

    vi.stubGlobal('fetch', async (url, opts) => {
      const input = JSON.parse(opts.body).input
      return {
        ok: true,
        json: async () => ({ data: input.map((t, i) => ({ index: i, embedding: [1, 0] })) })
      }
    })

    await rag.importDocs({ kbId: kb.id, paths: [file] })
    await rag.importDocs({ kbId: kb.id, paths: [file] })
    expect(repos.listDocs(dbm.get(), kb.id)).toHaveLength(1)
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('Embedding 接口报错时文档标记 error', async () => {
    const dir = makeTmpDir()
    const file = path.join(dir, 'c.md')
    fs.writeFileSync(file, '# X\n\n内容。')
    const pid = seedEmbedProvider()
    const kb = repos.createKb(dbm.get(), { name: '库', embedProviderId: pid, embedModel: 'emb' })

    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429, text: async () => 'rate' }))
    await rag.importDocs({ kbId: kb.id, paths: [file] })

    const docs = repos.listDocs(dbm.get(), kb.id)
    expect(docs[0].status).toBe('error')
    expect(docs[0].error).toContain('429')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('未配置 Embedding 模型时检索报错', async () => {
    const kb = repos.createKb(dbm.get(), { name: '裸库' })
    await expect(rag.searchKb(dbm.get(), kb, 'q', { k: 3 })).rejects.toThrow(/Embedding/)
  })
})
