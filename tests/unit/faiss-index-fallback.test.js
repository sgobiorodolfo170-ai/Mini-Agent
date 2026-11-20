import { beforeEach, describe, expect, it } from 'vitest'
import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import faissIndex from '../../electron/main/rag/faiss-index'

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
  faissIndex.invalidateAll()
})

// faiss-node 不可用（注入 faissOverride=null 模拟原生模块加载失败）→ 回退暴力余弦
describe('faiss fallback (brute force)', () => {
  it('searches via topK when faiss is unavailable', () => {
    const db = dbm.get()
    const kb = repos.createKb(db, { name: '测试库', embedModel: 'emb-1' })
    const docId = repos.insertDoc(db, {
      kbId: kb.id,
      path: 'C:\\a.md',
      title: 'a.md',
      size: 1,
      hash: 'h'
    })
    repos.insertChunks(db, docId, kb.id, [
      { seq: 0, text: '甲', vector: Float32Array.from([1, 0, 0]) },
      { seq: 1, text: '乙', vector: Float32Array.from([0, 1, 0]) }
    ])
    const entry = faissIndex.getKbIndex(db, kb.id, null)
    expect(entry.faiss).toBeNull()
    expect(entry.rows).toHaveLength(2)
    const hits = faissIndex.searchKbVectors({
      db,
      kbId: kb.id,
      queryVec: Float32Array.from([1, 0, 0]),
      k: 2,
      minScore: 0,
      faissOverride: null
    })
    expect(hits).toHaveLength(2)
    expect(hits[0].score).toBeGreaterThan(hits[1].score) // 甲余弦 1.0 > 乙 0
  })
})
