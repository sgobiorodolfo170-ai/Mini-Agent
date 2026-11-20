const crypto = require('crypto')

const uid = () => crypto.randomUUID()
const now = () => Date.now()

// ---------- settings ----------
function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key)
  if (!row) return undefined
  try {
    return JSON.parse(row.value)
  } catch {
    return row.value
  }
}

function setSetting(db, key, value) {
  db.prepare(
    'INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value === undefined ? null : value))
}

function getAllSettings(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  const out = {}
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value)
    } catch {
      out[r.key] = r.value
    }
  }
  return out
}

// ---------- providers ----------
function listProviders(db) {
  return db
    .prepare('SELECT * FROM providers WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE')
    .all()
}

function getProvider(db, id) {
  return db.prepare('SELECT * FROM providers WHERE id = ? AND deleted_at IS NULL').get(id)
}

function saveProvider(db, p) {
  const t = now()
  const models = JSON.stringify(Array.isArray(p.models) ? p.models : [])
  if (p.id) {
    db.prepare(
      `UPDATE providers SET name=?, base_url=?, rotation_strategy=?, probe_interval_min=?,
       probe_model=?, enabled=?, models=?, updated_at=? WHERE id=?`
    ).run(
      p.name,
      p.baseUrl,
      p.rotationStrategy || 'failover',
      p.probeIntervalMin ?? 30,
      p.probeModel || null,
      p.enabled === false ? 0 : 1,
      models,
      t,
      p.id
    )
    return p.id
  }
  const id = uid()
  db.prepare(
    `INSERT INTO providers(id, name, base_url, rotation_strategy, probe_interval_min, probe_model,
     enabled, models, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    p.name,
    p.baseUrl,
    p.rotationStrategy || 'failover',
    p.probeIntervalMin ?? 30,
    p.probeModel || null,
    p.enabled === false ? 0 : 1,
    models,
    t,
    t
  )
  return id
}

function softDeleteProvider(db, id) {
  const t = now()
  db.prepare('UPDATE providers SET deleted_at=?, updated_at=? WHERE id=?').run(t, t, id)
  db.prepare(
    'UPDATE api_keys SET deleted_at=?, updated_at=? WHERE provider_id=? AND deleted_at IS NULL'
  ).run(t, t, id)
}

// ---------- api keys ----------
function listKeys(db, providerId) {
  return db
    .prepare(
      `SELECT id, provider_id AS providerId, label, status, cooldown_until AS cooldownUntil,
       rate_count AS rateCount, last_used_at AS lastUsedAt, last_error AS lastError, sort
       FROM api_keys WHERE provider_id = ? AND deleted_at IS NULL ORDER BY sort`
    )
    .all(providerId)
}

function listAllKeysWithSecret(db) {
  return db
    .prepare(
      `SELECT id, provider_id AS providerId, label, secret_enc AS secretEnc, status,
       cooldown_until AS cooldownUntil, rate_count AS rateCount, last_used_at AS lastUsedAt,
       last_error AS lastError, sort FROM api_keys WHERE deleted_at IS NULL ORDER BY sort`
    )
    .all()
}

function getKeyWithSecret(db, id) {
  return db.prepare('SELECT * FROM api_keys WHERE id = ? AND deleted_at IS NULL').get(id)
}

function addKey(db, { providerId, label, secretEnc }) {
  const t = now()
  const id = uid()
  const sortRow = db
    .prepare(
      'SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM api_keys WHERE provider_id = ? AND deleted_at IS NULL'
    )
    .get(providerId)
  db.prepare(
    `INSERT INTO api_keys(id, provider_id, label, secret_enc, status, sort, created_at, updated_at)
     VALUES(?,?,?,?, 'unknown', ?, ?, ?)`
  ).run(id, providerId, label || '', secretEnc, sortRow.next, t, t)
  return id
}

function updateKeySecret(db, id, secretEnc) {
  db.prepare('UPDATE api_keys SET secret_enc=?, updated_at=? WHERE id=?').run(secretEnc, now(), id)
}

function softDeleteKey(db, id) {
  db.prepare('UPDATE api_keys SET deleted_at=?, updated_at=? WHERE id=?').run(now(), now(), id)
}

function updateKeyStatus(db, id, patch) {
  const cur = db.prepare('SELECT status, rate_count FROM api_keys WHERE id=?').get(id)
  if (!cur) return
  const status = patch.status ?? cur.status
  const rateCount = patch.rateCount !== undefined ? patch.rateCount : cur.rate_count
  db.prepare(
    `UPDATE api_keys SET status=?, cooldown_until=?, rate_count=?, last_used_at=?, last_error=?, updated_at=?
     WHERE id=?`
  ).run(
    status,
    patch.cooldownUntil ?? null,
    rateCount,
    patch.lastUsedAt ?? null,
    patch.lastError ?? null,
    now(),
    id
  )
}

function logKeyEvent(db, { apiKeyId, kind, result, detail }) {
  db.prepare('INSERT INTO key_events(api_key_id, kind, result, detail, at) VALUES(?,?,?,?,?)').run(
    apiKeyId,
    kind,
    result,
    detail || null,
    now()
  )
}

function listKeyEvents(db, limit = 100) {
  return db
    .prepare(
      `SELECT e.*, k.label AS keyLabel, k.provider_id AS providerId FROM key_events e
       LEFT JOIN api_keys k ON k.id = e.api_key_id
       WHERE k.deleted_at IS NULL ORDER BY e.id DESC LIMIT ?`
    )
    .all(limit)
}

// ---------- projects（项目工作目录） ----------
function listProjects(db) {
  return db
    .prepare(
      `SELECT id, name, path, sort, created_at AS createdAt, updated_at AS updatedAt
       FROM projects WHERE deleted_at IS NULL ORDER BY sort, created_at`
    )
    .all()
}

function getProject(db, id) {
  return db
    .prepare(
      `SELECT id, name, path, sort, created_at AS createdAt, updated_at AS updatedAt
       FROM projects WHERE id = ? AND deleted_at IS NULL`
    )
    .get(id)
}

function createProject(db, { name, path }) {
  const t = now()
  const id = uid()
  const sortRow = db
    .prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS next FROM projects WHERE deleted_at IS NULL')
    .get()
  db.prepare(
    `INSERT INTO projects(id, name, path, sort, created_at, updated_at) VALUES(?,?,?,?,?,?)`
  ).run(id, name, path, sortRow.next, t, t)
  return getProject(db, id)
}

function updateProject(db, id, patch) {
  const cur = getProject(db, id)
  if (!cur) return null
  db.prepare('UPDATE projects SET name=?, path=?, updated_at=? WHERE id=?').run(
    patch.name !== undefined ? patch.name : cur.name,
    patch.path !== undefined ? patch.path : cur.path,
    now(),
    id
  )
  return getProject(db, id)
}

function softDeleteProject(db, id) {
  const t = now()
  db.prepare('UPDATE projects SET deleted_at=?, updated_at=? WHERE id=?').run(t, t, id)
  // 项目删除后，其下会话回归「最近」（不删会话）
  db.prepare('UPDATE conversations SET project_id=NULL, updated_at=? WHERE project_id=?').run(t, id)
}

function countProjectSessions(db, projectId) {
  return db
    .prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_id=? AND deleted_at IS NULL')
    .get(projectId).n
}

// ---------- conversations ----------
function listConversations(db) {
  return db
    .prepare(
      `SELECT id, title, pinned, provider_id AS providerId, model, system_prompt AS systemPrompt,
       context_policy AS contextPolicy, project_id AS projectId,
       created_at AS createdAt, updated_at AS updatedAt
       FROM conversations WHERE deleted_at IS NULL
       ORDER BY pinned DESC, updated_at DESC`
    )
    .all()
}

function getConversation(db, id) {
  return db
    .prepare(
      `SELECT id, title, pinned, provider_id AS providerId, model, system_prompt AS systemPrompt,
       context_policy AS contextPolicy, project_id AS projectId,
       created_at AS createdAt, updated_at AS updatedAt
       FROM conversations WHERE id = ? AND deleted_at IS NULL`
    )
    .get(id)
}

function createConversation(db, opts = {}) {
  const t = now()
  const id = opts.id || uid()
  db.prepare(
    `INSERT INTO conversations(id, title, pinned, provider_id, model, system_prompt, context_policy,
     project_id, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    opts.title || '新会话',
    opts.pinned ? 1 : 0,
    opts.providerId || null,
    opts.model || null,
    opts.systemPrompt || null,
    opts.contextPolicy ? JSON.stringify(opts.contextPolicy) : '{}',
    opts.projectId || null,
    t,
    t
  )
  return getConversation(db, id)
}

function updateConversation(db, id, patch) {
  const cur = getConversation(db, id)
  if (!cur) return null
  db.prepare(
    `UPDATE conversations SET title=?, pinned=?, provider_id=?, model=?, system_prompt=?,
     context_policy=?, project_id=?, updated_at=? WHERE id=?`
  ).run(
    patch.title !== undefined ? patch.title : cur.title,
    patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : cur.pinned,
    patch.providerId !== undefined ? patch.providerId : cur.providerId,
    patch.model !== undefined ? patch.model : cur.model,
    patch.systemPrompt !== undefined ? patch.systemPrompt : cur.systemPrompt,
    patch.contextPolicy !== undefined ? JSON.stringify(patch.contextPolicy) : cur.contextPolicy,
    patch.projectId !== undefined ? patch.projectId : cur.projectId,
    now(),
    id
  )
  return getConversation(db, id)
}

function touchConversation(db, id) {
  db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now(), id)
}

function softDeleteConversation(db, id) {
  const t = now()
  db.prepare('UPDATE conversations SET deleted_at=?, updated_at=? WHERE id=?').run(t, t, id)
}

function searchConversations(db, q) {
  const like = `%${q}%`
  const byTitle = db
    .prepare(
      `SELECT id FROM conversations WHERE deleted_at IS NULL AND (title LIKE ? OR system_prompt LIKE ?)`
    )
    .all(like, like)
    .map((r) => r.id)
  const byMsg = db
    .prepare(
      `SELECT DISTINCT m.conversation_id AS id FROM messages m
       JOIN conversations c ON c.id = m.conversation_id AND c.deleted_at IS NULL
       WHERE m.deleted_at IS NULL AND m.content LIKE ?`
    )
    .all(like)
    .map((r) => r.id)
  const ids = [...new Set([...byTitle, ...byMsg])]
  return ids.map((id) => getConversation(db, id)).filter(Boolean)
}

// ---------- messages ----------
function listMessages(db, conversationId) {
  return db
    .prepare(
      `SELECT id, conversation_id AS conversationId, role, content, tool_calls AS toolCalls,
       attachments, meta, status, seq, created_at AS createdAt, updated_at AS updatedAt
       FROM messages WHERE conversation_id = ? AND deleted_at IS NULL ORDER BY seq`
    )
    .all(conversationId)
}

function nextSeq(db, conversationId) {
  const row = db
    .prepare(
      'SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE conversation_id = ? AND deleted_at IS NULL'
    )
    .get(conversationId)
  return row.next
}

function insertMessage(db, m) {
  const t = now()
  const id = m.id || uid()
  const seq = m.seq ?? nextSeq(db, m.conversationId)
  db.prepare(
    `INSERT INTO messages(id, conversation_id, role, content, tool_calls, attachments, meta, status,
     seq, created_at, updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    m.conversationId,
    m.role,
    m.content || '',
    m.toolCalls ? JSON.stringify(m.toolCalls) : null,
    m.attachments ? JSON.stringify(m.attachments) : null,
    m.meta ? JSON.stringify(m.meta) : null,
    m.status || 'done',
    seq,
    t,
    t
  )
  return { id, seq, createdAt: t }
}

function getMessage(db, id) {
  return db
    .prepare(
      `SELECT id, conversation_id AS conversationId, role, content, tool_calls AS toolCalls,
       attachments, meta, status, seq, created_at AS createdAt FROM messages WHERE id = ?`
    )
    .get(id)
}

function updateMessage(db, id, patch) {
  const cur = getMessage(db, id)
  if (!cur) return null
  db.prepare(
    `UPDATE messages SET content=?, tool_calls=?, attachments=?, meta=?, status=?, updated_at=? WHERE id=?`
  ).run(
    patch.content !== undefined ? patch.content : cur.content,
    patch.toolCalls !== undefined ? JSON.stringify(patch.toolCalls) : cur.toolCalls,
    patch.attachments !== undefined ? JSON.stringify(patch.attachments) : cur.attachments,
    patch.meta !== undefined ? JSON.stringify(patch.meta) : cur.meta,
    patch.status !== undefined ? patch.status : cur.status,
    now(),
    id
  )
  return getMessage(db, id)
}

function softDeleteMessagesFrom(db, conversationId, fromSeq) {
  db.prepare(
    'UPDATE messages SET deleted_at=?, updated_at=? WHERE conversation_id=? AND seq >= ? AND deleted_at IS NULL'
  ).run(now(), now(), conversationId, fromSeq)
}

function softDeleteMessage(db, id) {
  const cur = getMessage(db, id)
  if (!cur) return null
  db.prepare('UPDATE messages SET deleted_at=?, updated_at=? WHERE id=?').run(now(), now(), id)
  return getMessage(db, id)
}

// ---------- knowledge bases ----------
function listKbs(db) {
  return db
    .prepare(
      `SELECT id, name, embed_source AS embedSource, embed_provider_id AS embedProviderId,
       embed_model AS embedModel, embed_quant AS embedQuant, dim,
       created_at AS createdAt, updated_at AS updatedAt FROM kbs WHERE deleted_at IS NULL ORDER BY name`
    )
    .all()
}

function getKb(db, id) {
  return db
    .prepare(
      `SELECT id, name, embed_source AS embedSource, embed_provider_id AS embedProviderId,
       embed_model AS embedModel, embed_quant AS embedQuant, dim
       FROM kbs WHERE id = ? AND deleted_at IS NULL`
    )
    .get(id)
}

function createKb(db, { name, embedSource, embedProviderId, embedModel, embedQuant }) {
  const t = now()
  const id = uid()
  db.prepare(
    `INSERT INTO kbs(id, name, embed_source, embed_provider_id, embed_model, embed_quant,
     created_at, updated_at) VALUES(?,?,?,?,?,?,?,?)`
  ).run(
    id,
    name,
    embedSource === 'local' ? 'local' : 'remote',
    embedProviderId || null,
    embedModel || null,
    embedQuant || null,
    t,
    t
  )
  return getKb(db, id)
}

function updateKb(db, id, patch) {
  const cur = getKb(db, id)
  if (!cur) return null
  db.prepare(
    'UPDATE kbs SET name=?, embed_source=?, embed_provider_id=?, embed_model=?, embed_quant=?, updated_at=? WHERE id=?'
  ).run(
    patch.name !== undefined ? patch.name : cur.name,
    patch.embedSource !== undefined
      ? patch.embedSource === 'local'
        ? 'local'
        : 'remote'
      : cur.embedSource,
    patch.embedProviderId !== undefined ? patch.embedProviderId : cur.embedProviderId,
    patch.embedModel !== undefined ? patch.embedModel : cur.embedModel,
    patch.embedQuant !== undefined ? patch.embedQuant : cur.embedQuant,
    now(),
    id
  )
  return getKb(db, id)
}

function softDeleteKb(db, id) {
  const t = now()
  db.prepare('UPDATE kbs SET deleted_at=?, updated_at=? WHERE id=?').run(t, t, id)
  db.prepare(
    'UPDATE kb_documents SET deleted_at=?, updated_at=? WHERE kb_id=? AND deleted_at IS NULL'
  ).run(t, t, id)
}

function listDocs(db, kbId) {
  return db
    .prepare(
      `SELECT id, kb_id AS kbId, path, title, mime, size, hash, chunk_count AS chunkCount, status,
       error, created_at AS createdAt FROM kb_documents WHERE kb_id = ? AND deleted_at IS NULL ORDER BY created_at`
    )
    .all(kbId)
}

function insertDoc(db, { kbId, path, title, mime, size, hash }) {
  const t = now()
  const id = uid()
  db.prepare(
    `INSERT INTO kb_documents(id, kb_id, path, title, mime, size, hash, status, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?, 'pending', ?, ?)`
  ).run(id, kbId, path, title, mime || null, size || 0, hash, t, t)
  return id
}

function getDocByHash(db, kbId, hash) {
  return db
    .prepare('SELECT * FROM kb_documents WHERE kb_id = ? AND hash = ? AND deleted_at IS NULL')
    .get(kbId, hash)
}

function updateDocStatus(db, id, patch) {
  db.prepare(
    'UPDATE kb_documents SET status=?, chunk_count=?, error=?, updated_at=? WHERE id=?'
  ).run(patch.status, patch.chunkCount ?? 0, patch.error ?? null, now(), id)
}

function softDeleteDoc(db, id) {
  db.prepare(
    'DELETE FROM kb_embeddings WHERE chunk_id IN (SELECT id FROM kb_chunks WHERE document_id=?)'
  ).run(id)
  db.prepare('DELETE FROM kb_chunks WHERE document_id=?').run(id)
  db.prepare('UPDATE kb_documents SET deleted_at=?, updated_at=? WHERE id=?').run(now(), now(), id)
}

function insertChunks(db, docId, kbId, chunks) {
  const stmt = db.prepare(
    'INSERT INTO kb_chunks(id, document_id, kb_id, seq, heading_path, text, token_count) VALUES(?,?,?,?,?,?,?)'
  )
  const embStmt = db.prepare(
    'INSERT INTO kb_embeddings(chunk_id, kb_id, dim, embedding) VALUES(?,?,?,?)'
  )
  db.exec('BEGIN')
  try {
    for (const c of chunks) {
      const id = uid()
      stmt.run(id, docId, kbId, c.seq, c.headingPath || null, c.text, c.text.length)
      if (c.vector) {
        const buf = float32ToBuffer(c.vector)
        embStmt.run(id, kbId, c.vector.length, buf)
      }
    }
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return chunks.length
}

function float32ToBuffer(vec) {
  const buf = Buffer.alloc(vec.length * 4)
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4)
  return buf
}

function bufferToFloat32(buf, dim) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  const out = new Float32Array(dim)
  for (let i = 0; i < dim; i++) out[i] = b.readFloatLE(i * 4)
  return out
}

function listEmbeddingsByKb(db, kbId) {
  const rows = db
    .prepare('SELECT chunk_id AS chunkId, dim, embedding FROM kb_embeddings WHERE kb_id = ?')
    .all(kbId)
  return rows.map((r) => ({
    chunkId: r.chunkId,
    dim: r.dim,
    vector: bufferToFloat32(r.embedding, r.dim)
  }))
}

function getChunkTexts(db, chunkIds) {
  if (!chunkIds.length) return []
  const placeholders = chunkIds.map(() => '?').join(',')
  const rows = db
    .prepare(
      `SELECT c.id, c.text, c.heading_path AS headingPath, d.title AS docTitle, d.id AS docId
       FROM kb_chunks c JOIN kb_documents d ON d.id = c.document_id
       WHERE c.id IN (${placeholders})`
    )
    .all(...chunkIds)
  const order = new Map(chunkIds.map((id, i) => [id, i]))
  return rows.sort((a, b) => order.get(a.id) - order.get(b.id))
}

function getKbStats(db, kbId) {
  const docs = db
    .prepare('SELECT COUNT(*) AS n FROM kb_documents WHERE kb_id=? AND deleted_at IS NULL')
    .get(kbId).n
  const chunks = db.prepare('SELECT COUNT(*) AS n FROM kb_chunks WHERE kb_id=?').get(kbId).n
  return { docs, chunks }
}

// ---------- agent ----------
function createRun(db, { conversationId, goal, maxSteps }) {
  const id = uid()
  db.prepare(
    `INSERT INTO agent_runs(id, conversation_id, goal, status, max_steps, started_at)
     VALUES(?,?,?, 'running', ?, ?)`
  ).run(id, conversationId || null, goal, maxSteps || 15, now())
  return id
}

function updateRun(db, id, patch) {
  db.prepare('UPDATE agent_runs SET status=?, steps_used=?, ended_at=? WHERE id=?').run(
    patch.status,
    patch.stepsUsed ?? 0,
    patch.endedAt ?? null,
    id
  )
}

function logToolCall(
  db,
  { runId, step, tool, args, riskLevel, confirmedBy, result, error, durationMs }
) {
  db.prepare(
    `INSERT INTO agent_tool_calls(run_id, step, tool, args, risk_level, confirmed_by, result, error,
     duration_ms, at) VALUES(?,?,?,?,?,?,?,?,?,?)`
  ).run(
    runId,
    step,
    tool,
    JSON.stringify(args || {}),
    riskLevel,
    confirmedBy,
    result ? String(result).slice(0, 20000) : null,
    error || null,
    durationMs ?? null,
    now()
  )
}

function listRuns(db, limit = 50) {
  return db
    .prepare(
      `SELECT r.*, c.title AS conversationTitle FROM agent_runs r
       LEFT JOIN conversations c ON c.id = r.conversation_id
       ORDER BY r.started_at DESC LIMIT ?`
    )
    .all(limit)
}

function getRunCalls(db, runId) {
  return db.prepare('SELECT * FROM agent_tool_calls WHERE run_id = ? ORDER BY step').all(runId)
}

module.exports = {
  uid,
  now,
  getSetting,
  setSetting,
  getAllSettings,
  listProjects,
  getProject,
  createProject,
  updateProject,
  softDeleteProject,
  countProjectSessions,
  listProviders,
  getProvider,
  saveProvider,
  softDeleteProvider,
  listKeys,
  listAllKeysWithSecret,
  getKeyWithSecret,
  addKey,
  updateKeySecret,
  softDeleteKey,
  updateKeyStatus,
  logKeyEvent,
  listKeyEvents,
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  touchConversation,
  softDeleteConversation,
  searchConversations,
  listMessages,
  nextSeq,
  insertMessage,
  getMessage,
  updateMessage,
  softDeleteMessagesFrom,
  softDeleteMessage,
  listKbs,
  getKb,
  createKb,
  updateKb,
  softDeleteKb,
  listDocs,
  insertDoc,
  getDocByHash,
  updateDocStatus,
  softDeleteDoc,
  insertChunks,
  float32ToBuffer,
  bufferToFloat32,
  listEmbeddingsByKb,
  getChunkTexts,
  getKbStats,
  createRun,
  updateRun,
  logToolCall,
  listRuns,
  getRunCalls
}
