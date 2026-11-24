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
const { isShuttingDown } = require('../lifecycle')
const { collectWorkspaceFiles } = require('./workspace-files')

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
      title:
        kb.kind === 'workspace' && kb.rootPath
          ? path.relative(kb.rootPath, filePath)
          : path.basename(filePath),
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
async function importDocs({ kbId, paths, existingDocs = null }) {
  const db = dbm.get()
  const kb = repos.getKb(db, kbId)
  if (!kb) throw new Error('知识库不存在')
  const total = paths.length
  let done = 0
  let failed = 0
  let skipped = 0
  for (const p of paths) {
    if (isShuttingDown()) {
      broadcast('kb:progress', {
        kbId,
        projectId: kb.projectId,
        workspace: kb.kind === 'workspace',
        done: true,
        total,
        aborted: true
      })
      return { done, aborted: true }
    }
    try {
      const existingDoc = existingDocs && existingDocs.get(path.resolve(p).toLowerCase())
      const r = await processDoc(db, kb, p, { existingDocId: existingDoc?.id || null })
      done++
      if (r.error) failed++
      if (r.skipped) skipped++
      broadcast('kb:progress', {
        kbId,
        projectId: kb.projectId,
        workspace: kb.kind === 'workspace',
        current: done,
        total,
        path: p,
        status: r.skipped ? 'skipped' : r.error ? 'error' : 'ready',
        detail: r.error || `${r.chunks} 块`
      })
    } catch (e) {
      done++
      failed++
      broadcast('kb:progress', {
        kbId,
        projectId: kb.projectId,
        workspace: kb.kind === 'workspace',
        current: done,
        total,
        path: p,
        status: 'error',
        detail: String((e && e.message) || e).slice(0, 200)
      })
    }
  }
  invalidate(kbId)
  broadcast('kb:progress', {
    kbId,
    projectId: kb.projectId,
    workspace: kb.kind === 'workspace',
    done: true,
    total,
    failed,
    skipped
  })
  return { done, failed, skipped }
}

async function rebuildKb({ kbId }) {
  const db = dbm.get()
  const kb = repos.getKb(db, kbId)
  if (!kb) throw new Error('知识库不存在')
  if (kb.kind === 'workspace') {
    const files = await collectWorkspaceFiles(kb.rootPath)
    const existing = new Map(
      repos.listDocs(db, kbId).map((doc) => [path.resolve(doc.path).toLowerCase(), doc])
    )
    const current = new Set(files.map((file) => path.resolve(file).toLowerCase()))
    for (const doc of existing.values()) {
      if (!current.has(path.resolve(doc.path).toLowerCase())) repos.softDeleteDoc(db, doc.id)
    }
    return importDocs({ kbId, paths: files, existingDocs: existing })
  }
  const docs = repos.listDocs(db, kbId).filter((d) => d.status !== 'pending')
  const total = docs.length
  let done = 0
  for (const d of docs) {
    if (isShuttingDown()) {
      broadcast('kb:progress', {
        kbId,
        projectId: kb.projectId,
        workspace: kb.kind === 'workspace',
        done: true,
        total,
        aborted: true
      })
      return { done, aborted: true }
    }
    try {
      await processDoc(db, kb, d.path, { existingDocId: d.id })
    } catch (e) {
      repos.updateDocStatus(db, d.id, {
        status: 'error',
        error: String((e && e.message) || e).slice(0, 300)
      })
    }
    done++
    broadcast('kb:progress', {
      kbId,
      projectId: kb.projectId,
      workspace: kb.kind === 'workspace',
      current: done,
      total,
      path: d.path,
      status: 'rebuilt'
    })
  }
  invalidate(kbId)
  broadcast('kb:progress', {
    kbId,
    projectId: kb.projectId,
    workspace: kb.kind === 'workspace',
    done: true,
    total
  })
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

function resolveWorkspaceEmbedding(db) {
  const downloaded = localModels.listPackages(modelsRootFor()).find((pkg) => pkg.downloaded)
  if (downloaded) {
    return {
      embedSource: 'local',
      embedModel: downloaded.model,
      embedQuant: downloaded.quant
    }
  }
  const keys = repos.listAllKeysWithSecret(db)
  const usableKeys = keys.filter((key) => ['ok', 'unknown', 'cooldown'].includes(key.status))
  const configured = repos.listKbs(db).find((kb) => {
    if (kb.embedSource === 'local' || !kb.embedProviderId || !kb.embedModel) return false
    const provider = repos.getProvider(db, kb.embedProviderId)
    return provider?.enabled !== 0 && usableKeys.some((key) => key.providerId === provider.id)
  })
  if (configured) {
    return {
      embedSource: 'remote',
      embedProviderId: configured.embedProviderId,
      embedModel: configured.embedModel
    }
  }
  for (const provider of repos.listProviders(db)) {
    if (provider.enabled === 0 || !usableKeys.some((key) => key.providerId === provider.id))
      continue
    const models = JSON.parse(provider.models || '[]')
    const embedModel = models.find((model) =>
      /embed|bge|gte|e5|text2vec/i.test(String(model.id || ''))
    )
    if (embedModel) {
      return { embedSource: 'remote', embedProviderId: provider.id, embedModel: embedModel.id }
    }
  }
  return { embedSource: 'remote', embedProviderId: null, embedModel: null }
}

function workspaceEmbeddingError(db, kb) {
  if (kb.embedSource === 'local') {
    const pkg = localModels.getPackage(`${kb.embedModel}:${kb.embedQuant || 'fp32'}`)
    if (!pkg || !localModels.isDownloaded(modelsRootFor(), pkg)) {
      return '请先在「设置 → 本地嵌入模型」下载模型，或在知识库中配置远程 Embedding'
    }
    return null
  }
  if (!kb.embedProviderId || !kb.embedModel) {
    return '请先配置远程 Embedding 供应商与模型，再重建工作区索引'
  }
  const provider = repos.getProvider(db, kb.embedProviderId)
  const hasKey = repos
    .listAllKeysWithSecret(db)
    .some(
      (key) =>
        key.providerId === kb.embedProviderId && ['ok', 'unknown', 'cooldown'].includes(key.status)
    )
  if (!provider || provider.enabled === 0 || !hasKey) return 'Embedding 供应商不可用或没有 Key'
  return null
}

const activeProjectIndexes = new Set()

function startProjectIndex({ projectId, rebuild = false }) {
  const db = dbm.get()
  const project = repos.getProject(db, projectId)
  if (!project) throw new Error('项目不存在')
  let kb = repos.getProjectKb(db, projectId)
  if (!kb) {
    kb = repos.createKb(db, {
      name: `${project.name} · 工作区索引`,
      ...resolveWorkspaceEmbedding(db),
      projectId,
      kind: 'workspace',
      rootPath: project.path
    })
    broadcast('kb:changed', { kbId: kb.id, projectId })
  }
  if (activeProjectIndexes.has(kb.id)) return { started: false, kbId: kb.id, reason: 'indexing' }
  let error = workspaceEmbeddingError(db, kb)
  if (error && rebuild) {
    const resolved = resolveWorkspaceEmbedding(db)
    if (resolved.embedProviderId || resolved.embedModel) {
      repos.updateKb(db, kb.id, resolved)
      db.prepare('UPDATE kbs SET dim=NULL WHERE id=?').run(kb.id)
      kb = repos.getKb(db, kb.id)
      error = workspaceEmbeddingError(db, kb)
    }
  }
  if (error) {
    broadcast('kb:progress', {
      kbId: kb.id,
      projectId,
      workspace: true,
      done: true,
      total: 0,
      error
    })
    return { started: false, kbId: kb.id, error }
  }
  activeProjectIndexes.add(kb.id)
  broadcast('kb:progress', {
    kbId: kb.id,
    projectId,
    workspace: true,
    current: 0,
    total: 0,
    status: 'scanning'
  })
  rebuildKb({ kbId: kb.id })
    .then((result) => {
      if (result?.aborted) return
      if (result?.failed) {
        broadcast('app:notice', {
          level: 'warn',
          message: `工作区索引${rebuild ? '重建' : '创建'}完成，但有 ${result.failed} 个文件失败，请在知识库中查看`
        })
      } else {
        broadcast('app:notice', {
          level: 'success',
          message: `工作区索引${rebuild ? '已重建' : '已创建'}：${project.name}`
        })
      }
    })
    .catch((e) => {
      broadcast('kb:progress', {
        kbId: kb.id,
        projectId,
        workspace: true,
        done: true,
        error: String((e && e.message) || e).slice(0, 300)
      })
    })
    .finally(() => activeProjectIndexes.delete(kb.id))
  return { started: true, kbId: kb.id }
}

async function retrieveProjectKb(db, projectId, query, { k = 5 } = {}) {
  const kb = repos.getProjectKb(db, projectId)
  if (!kb) return null
  const text = String(query || '').trim()
  if (!text) return { kbId: kb.id, kbName: kb.name, blocks: [], refs: [], warning: null }
  try {
    const result = await searchKb(db, kb, text, { k })
    return {
      kbId: kb.id,
      kbName: kb.name,
      blocks: result.blocks.map((block, index) => ({ ...block, n: index + 1 })),
      refs: result.blocks,
      warning: null
    }
  } catch (e) {
    return {
      kbId: kb.id,
      kbName: kb.name,
      blocks: [],
      refs: [],
      warning: String((e && e.message) || e).slice(0, 200)
    }
  }
}

module.exports = {
  importDocs,
  rebuildKb,
  searchKb,
  processDoc,
  modelsRootFor,
  startProjectIndex,
  retrieveProjectKb
}
