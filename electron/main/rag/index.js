const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const repos = require('../../store/repos')
const dbm = require('../../store/db')
const { chunkDocument } = require('./chunk')
const { embedTexts } = require('./extract-embed')
const { embedTextsLocal } = require('./embed-local')
const localModels = require('./local-models')
const { searchKbVectors, invalidate } = require('./faiss-index')
const { extractText } = require('./extract')
const { decryptSecret } = require('../../store/keys')
const { broadcast } = require('../notify')

function chunkOpts(db) {
  return {
    maxLen: Number(repos.getSetting(db, 'kbChunkMaxLen')) || 800,
    overlap: Number(repos.getSetting(db, 'kbChunkOverlap')) || 120
  }
}

// 本地模型包根目录：与数据库同级的 models/ 目录。
function modelsRootFor() {
  const info = dbm.info()
  if (info && info.path && info.path !== ':memory:') {
    return path.join(path.dirname(info.path), 'models')
  }
  return path.join(process.cwd(), '.miniagent-models')
}

// 按知识库的嵌入来源分流：local（onnxruntime 本地推理）或 remote（OpenAI 兼容 /embeddings）。
async function embedBatch(db, kb, texts, { queryMode = false, modelsRoot } = {}) {
  const root = modelsRoot || modelsRootFor()
  if (kb.embedSource === 'local') {
    const pkgId = `${kb.embedModel}:${kb.embedQuant || 'fp32'}`
    const pkg = localModels.getPackage(pkgId)
    if (!pkg) throw new Error(`本地嵌入模型包无效: ${pkgId}`)
    if (!localModels.isDownloaded(root, pkg)) {
      throw new Error('本地嵌入模型尚未下载，请到「设置 → 本地嵌入模型」一键下载')
    }
    return embedTextsLocal({ modelsRoot: root, pkg, texts, queryMode })
  }
  const provider = repos.getProvider(db, kb.embedProviderId)
  if (!provider) throw new Error('Embedding 供应商不存在')
  const keyRows = repos.listAllKeysWithSecret(db).filter((x) => x.providerId === provider.id)
  const key = keyRows.find(
    (x) => x.status === 'ok' || x.status === 'unknown' || x.status === 'cooldown'
  )
  if (!key) throw new Error('Embedding 供应商无可用 Key')
  return embedTexts({
    baseUrl: provider.base_url,
    apiKey: await decryptSecret(key.secretEnc),
    model: kb.embedModel,
    texts
  })
}

function resetDocChunks(db, docId) {
  db.prepare(
    'DELETE FROM kb_embeddings WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE document_id=?)'
  ).run(docId)
  db.prepare('DELETE FROM kb_chunks WHERE document_id=?').run(docId)
  db.prepare(
    "UPDATE kb_documents SET status='pending', chunk_count=0, updated_at=? WHERE id=?"
  ).run(Date.now(), docId)
}

async function processDoc(db, kb, filePath, { existingDocId = null } = {}) {
  const buf = fs.readFileSync(filePath)
  const hash = crypto.createHash('sha1').update(buf).digest('hex')
  let docId = existingDocId
  if (!docId) {
    const dup = repos.getDocByHash(db, kb.id, hash)
    if (dup) return { docId: dup.id, skipped: true, chunks: dup.chunk_count }
    const stat = fs.statSync(filePath)
    docId = repos.insertDoc(db, {
      kbId: kb.id,
      path: filePath,
      title: path.basename(filePath),
      mime: path.extname(filePath).slice(1),
      size: stat.size,
      hash
    })
  } else {
    resetDocChunks(db, docId)
  }
  try {
    const { text } = await extractText(filePath)
    if (!text || !text.trim()) throw new Error('未提取到文本内容')
    const chunks = chunkDocument(text, chunkOpts(db))
    if (!chunks.length) throw new Error('文档为空')
    const { vectors, dim } = await embedBatch(
      db,
      kb,
      chunks.map((c) => c.text)
    )
    chunks.forEach((c, i) => {
      c.vector = vectors[i]
    })
    repos.insertChunks(db, docId, kb.id, chunks)
    if (!kb.dim) {
      db.prepare('UPDATE kbs SET dim=?, updated_at=? WHERE id=?').run(dim, Date.now(), kb.id)
    }
    repos.updateDocStatus(db, docId, { status: 'ready', chunkCount: chunks.length })
    return { docId, chunks: chunks.length }
  } catch (e) {
    const msg = String((e && e.message) || e).slice(0, 300)
    repos.updateDocStatus(db, docId, { status: 'error', error: msg })
    return { docId, error: msg }
  }
}

// Fire-and-forget import with progress events.
async function importDocs({ kbId, paths }) {
  const db = dbm.get()
  const kb = repos.getKb(db, kbId)
  if (!kb) throw new Error('知识库不存在')
  const total = paths.length
  let done = 0
  for (const p of paths) {
    try {
      const r = await processDoc(db, kb, p)
      done++
      broadcast('kb:progress', {
        kbId,
        current: done,
        total,
        path: p,
        status: r.skipped ? 'skipped' : r.error ? 'error' : 'ready',
        detail: r.error || `${r.chunks} 块`
      })
    } catch (e) {
      done++
      broadcast('kb:progress', {
        kbId,
        current: done,
        total,
        path: p,
        status: 'error',
        detail: String((e && e.message) || e).slice(0, 200)
      })
    }
  }
  invalidate(kbId)
  broadcast('kb:progress', { kbId, done: true, total })
  return { done }
}

async function rebuildKb({ kbId }) {
  const db = dbm.get()
  const kb = repos.getKb(db, kbId)
  if (!kb) throw new Error('知识库不存在')
  const docs = repos.listDocs(db, kbId).filter((d) => d.status !== 'pending')
  const total = docs.length
  let done = 0
  for (const d of docs) {
    try {
      await processDoc(db, kb, d.path, { existingDocId: d.id })
    } catch (e) {
      repos.updateDocStatus(db, d.id, {
        status: 'error',
        error: String((e && e.message) || e).slice(0, 300)
      })
    }
    done++
    broadcast('kb:progress', { kbId, current: done, total, path: d.path, status: 'rebuilt' })
  }
  invalidate(kbId)
  broadcast('kb:progress', { kbId, done: true, total })
  return { done }
}

async function searchKb(db, kb, query, { k = 5, minScore = 0.2, modelsRoot } = {}) {
  if (kb.embedSource === 'local') {
    if (!kb.embedModel) throw new Error('知识库未配置本地嵌入模型')
  } else if (!kb.embedProviderId || !kb.embedModel) {
    throw new Error('知识库未配置 Embedding 模型')
  }
  const { vectors } = await embedBatch(db, kb, [query], { queryMode: true, modelsRoot })
  const q = vectors[0]
  const hits = searchKbVectors({ db, kbId: kb.id, queryVec: q, k, minScore })
  const texts = repos.getChunkTexts(
    db,
    hits.map((h) => h.chunkId)
  )
  return {
    dim: q.length,
    blocks: hits.map((h, i) => ({
      chunkId: h.chunkId,
      score: Number(h.score.toFixed(4)),
      text: (texts[i] && texts[i].text) || '',
      title: (texts[i] && texts[i].docTitle) || '',
      docId: (texts[i] && texts[i].docId) || '',
      headingPath: (texts[i] && texts[i].headingPath) || null
    }))
  }
}

module.exports = { importDocs, rebuildKb, searchKb, processDoc, modelsRootFor }
