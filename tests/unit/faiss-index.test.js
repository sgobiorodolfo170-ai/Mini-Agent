import { beforeEach, describe, expect, it } from 'vitest'
import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import faissIndex from '../../electron/main/rag/faiss-index'

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
  faissIndex.invalidateAll()
})

function seedKb(chunks) {
  const db = dbm.get()
  const kb = repos.createKb(db, { name: '测试库', embedModel: 'emb-1' })
  const docId = repos.insertDoc(db, {
    kbId: kb.id,
    path: 'C:\\a.md',
    title: 'a.md',
    size: 1,
    hash: 'h-' + Math.random()
  })
  repos.insertChunks(db, docId, kb.id, chunks)
  return kb
}

describe('faiss index', () => {
  it('builds a real faiss index and finds nearest vector', () => {
    expect(faissIndex.loadFaiss()).toBeTruthy() // Node 环境应加载成功
    const kb = seedKb([
      { seq: 0, text: '甲', vector: Float32Array.from([1, 0, 0]) },
      { seq: 1, text: '乙', vector: Float32Array.from([0, 1, 0]) },
      { seq: 2, text: '丙', vector: Float32Array.from([0.9, 0.1, 0]) }
    ])
    const db = dbm.get()
    const hits = faissIndex.searchKbVectors({
      db,
      kbId: kb.id,
      queryVec: Float32Array.from([1, 0, 0]),
      k: 2,
      minScore: 0
    })
    expect(hits).toHaveLength(2)
    expect(hits[0].chunkId).toBeDefined()
    // 索引内向量已归一化，内积即余弦：与甲正交的乙分数应接近 0
    const scores = hits.map((h) => h.score)
    expect(scores[0]).toBeGreaterThan(scores[1])
    faissIndex.invalidate(kb.id)
  })

  it('caches index per kb and invalidates', () => {
    const kb = seedKb([{ seq: 0, text: '甲', vector: Float32Array.from([1, 0, 0]) }])
    const db = dbm.get()
    const a = faissIndex.getKbIndex(db, kb.id)
    const b = faissIndex.getKbIndex(db, kb.id)
    expect(b).toBe(a) // 同一缓存实例
    faissIndex.invalidate(kb.id)
    const c = faissIndex.getKbIndex(db, kb.id)
    expect(c).not.toBe(a)
  })

  it('empty kb and dim mismatch return no hits', () => {
    const kb = seedKb([])
    const db = dbm.get()
    expect(
      faissIndex.searchKbVectors({ db, kbId: kb.id, queryVec: Float32Array.from([1, 0]), k: 2 })
    ).toEqual([])
    const kb2 = seedKb([{ seq: 0, text: '甲', vector: Float32Array.from([1, 0, 0]) }])
    expect(
      faissIndex.searchKbVectors({ db, kbId: kb2.id, queryVec: Float32Array.from([1, 0]), k: 2 })
    ).toEqual([]) // 查询维度 2 != 索引维度 3
  })

  it('k larger than ntotal is clamped, no -1 labels leak', () => {
    const kb = seedKb([{ seq: 0, text: '甲', vector: Float32Array.from([1, 0, 0]) }])
    const db = dbm.get()
    const hits = faissIndex.searchKbVectors({
      db,
      kbId: kb.id,
      queryVec: Float32Array.from([1, 0, 0]),
      k: 10,
      minScore: -1
    })
    expect(hits).toHaveLength(1)
  })
})
