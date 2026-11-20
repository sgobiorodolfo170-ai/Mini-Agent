const repos = require('../../store/repos')
const { l2normalize } = require('./embed-local')
const { topK } = require('./search')

// faiss-node 向量索引：IndexFlatIP + L2 归一化 = 余弦相似度。
// 加载失败（如 ABI 不匹配）时自动回退到暴力余弦（search.js），功能等价仅性能差异。
let faissImplCache // undefined=未尝试, null=不可用
function loadFaiss() {
  if (faissImplCache !== undefined) return faissImplCache
  try {
    faissImplCache = require('faiss-node')
  } catch {
    faissImplCache = null
  }
  return faissImplCache
}

function buildIndex(rows, dim, faissImpl) {
  const index = new faissImpl.IndexFlatIP(dim)
  if (!rows.length) return index
  const flat = new Float32Array(rows.length * dim)
  rows.forEach((r, i) => {
    flat.set(l2normalize(Float32Array.from(r.vector)), i * dim)
  })
  index.add(Array.from(flat))
  return index
}

// 每库内存索引缓存（构建自 SQLite 中的 Float32 BLOB）。
const caches = new Map() // kbId -> { dim, chunkIds, index, faiss }

function getKbIndex(db, kbId, faissOverride) {
  if (caches.has(kbId)) return caches.get(kbId)
  const rows = repos.listEmbeddingsByKb(db, kbId)
  if (!rows.length) {
    const empty = { dim: 0, chunkIds: [], index: null, faiss: null, empty: true }
    caches.set(kbId, empty)
    return empty
  }
  const dim = rows[0].dim
  const usable = rows.filter((r) => r.dim === dim)
  // faissOverride 用于测试注入（undefined = 正常加载，null = 强制走暴力回退）
  const faiss = faissOverride !== undefined ? faissOverride : loadFaiss()
  let entry
  if (faiss) {
    entry = {
      dim,
      chunkIds: usable.map((r) => r.chunkId),
      index: buildIndex(usable, dim, faiss),
      faiss,
      empty: false
    }
  } else {
    // 回退：保存原始向量走暴力余弦
    entry = { dim, chunkIds: [], index: null, faiss: null, empty: false, rows: usable }
  }
  caches.set(kbId, entry)
  return entry
}

function invalidate(kbId) {
  caches.delete(kbId)
}

function invalidateAll() {
  caches.clear()
}

// 统一检索入口：返回 [{ chunkId, score }]（内积 = 余弦，因两侧均已归一化）。
function searchKbVectors({ db, kbId, queryVec, k = 5, minScore = 0.2, faissOverride }) {
  const entry = getKbIndex(db, kbId, faissOverride)
  if (entry.empty) return []
  if (queryVec.length !== entry.dim) return []
  if (entry.faiss) {
    const q = l2normalize(Float32Array.from(queryVec))
    const res = entry.index.search(Array.from(q), Math.max(1, Math.min(k, entry.index.ntotal())))
    const out = []
    res.labels.forEach((label, i) => {
      if (label < 0) return
      const score = res.distances[i]
      if (score >= minScore) out.push({ chunkId: entry.chunkIds[label], score })
    })
    out.sort((a, b) => b.score - a.score)
    return out
  }
  return topK(queryVec, entry.rows, { k, minScore })
}

module.exports = { loadFaiss, buildIndex, getKbIndex, invalidate, invalidateAll, searchKbVectors }
