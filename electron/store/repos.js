const crypto = require('crypto')

const uid = () => crypto.randomUUID()
const now = () => Date.now()

// 权限分级四级（会话记忆用）：非法值一律收敛到 default，不放大
const PERMISSION_MODES = ['default', 'readonly', 'autonomous', 'full']

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
  const cur = db.prepare('SELECT status, rate_count, last_used_at FROM api_keys WHERE id=?').get(id)
  if (!cur) return
  const status = patch.status ?? cur.status
  const rateCount = patch.rateCount !== undefined ? patch.rateCount : cur.rate_count
  // lastUsedAt 缺省时保留原值：失败分支不带该字段，若置 NULL 会让
  // round_robin 的 LRU 排序把「刚失败的 Key」排到最前（(lastUsedAt||0) 最小）。
  const lastUsedAt = patch.lastUsedAt !== undefined ? patch.lastUsedAt : cur.last_used_at
  db.prepare(
    `UPDATE api_keys SET status=?, cooldown_until=?, rate_count=?, last_used_at=?, last_error=?, updated_at=?
     WHERE id=?`
  ).run(
    status,
    patch.cooldownUntil ?? null,
    rateCount,
    lastUsedAt ?? null,
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
      `SELECT id, name, path, pinned, sort, created_at AS createdAt, updated_at AS updatedAt
       FROM projects WHERE deleted_at IS NULL ORDER BY pinned DESC, sort, created_at`
    )
    .all()
}

function getProject(db, id) {
  return db
    .prepare(
      `SELECT id, name, path, pinned, sort, created_at AS createdAt, updated_at AS updatedAt
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
  db.prepare('UPDATE projects SET name=?, path=?, pinned=?, updated_at=? WHERE id=?').run(
    patch.name !== undefined ? patch.name : cur.name,
    patch.path !== undefined ? patch.path : cur.path,
    patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : cur.pinned,
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
       context_policy AS contextPolicy, project_id AS projectId, permission,
       origin, parent_id AS parentId, created_by_run AS createdByRun,
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
       context_policy AS contextPolicy, project_id AS projectId, permission,
       origin, parent_id AS parentId, created_by_run AS createdByRun,
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
     project_id, permission, origin, parent_id, created_by_run, created_at, updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    opts.title || '新会话',
    opts.pinned ? 1 : 0,
    opts.providerId || null,
    opts.model || null,
    opts.systemPrompt || null,
    opts.contextPolicy ? JSON.stringify(opts.contextPolicy) : '{}',
    opts.projectId || null,
    PERMISSION_MODES.includes(opts.permission) ? opts.permission : 'default',
    // 人工创建的会话 origin=user；Agent 通过 session_create 创建时传 origin=agent
    opts.origin === 'agent' ? 'agent' : 'user',
    opts.parentId || null,
    opts.createdByRun || null,
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
     context_policy=?, project_id=?, permission=?, updated_at=? WHERE id=?`
  ).run(
    patch.title !== undefined ? patch.title : cur.title,
    patch.pinned !== undefined ? (patch.pinned ? 1 : 0) : cur.pinned,
    patch.providerId !== undefined ? patch.providerId : cur.providerId,
    patch.model !== undefined ? patch.model : cur.model,
    patch.systemPrompt !== undefined ? patch.systemPrompt : cur.systemPrompt,
    patch.contextPolicy !== undefined ? JSON.stringify(patch.contextPolicy) : cur.contextPolicy,
    patch.projectId !== undefined ? patch.projectId : cur.projectId,
    // 非法权限值保持原值（收敛不放大原则）
    patch.permission !== undefined
      ? PERMISSION_MODES.includes(patch.permission)
        ? patch.permission
        : cur.permission
      : cur.permission,
    now(),
    id
  )
  return getConversation(db, id)
}

// Agent 创建的子会话：按父会话或创建者运行回溯
function listChildConversations(db, parentId) {
  return db
    .prepare(
      `SELECT id, title, pinned, provider_id AS providerId, model, system_prompt AS systemPrompt,
       context_policy AS contextPolicy, project_id AS projectId, permission,
       origin, parent_id AS parentId, created_by_run AS createdByRun,
       created_at AS createdAt, updated_at AS updatedAt
       FROM conversations WHERE deleted_at IS NULL AND parent_id = ?
       ORDER BY created_at ASC`
    )
    .all(parentId)
}

function listAgentConversations(db, runId) {
  const rows = db
    .prepare(
      `SELECT id, title, pinned, provider_id AS providerId, model, system_prompt AS systemPrompt,
       context_policy AS contextPolicy, project_id AS projectId, permission,
       origin, parent_id AS parentId, created_by_run AS createdByRun,
       created_at AS createdAt, updated_at AS updatedAt
       FROM conversations WHERE deleted_at IS NULL AND origin = 'agent'
       ORDER BY created_at DESC`
    )
    .all()
  return runId ? rows.filter((r) => r.createdByRun === runId) : rows
}

function touchConversation(db, id) {
  db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now(), id)
}

function assertNoActiveRun(db, conversationId) {
  if (
    db
      .prepare(
        `SELECT 1 FROM agent_runs WHERE conversation_id=? AND status IN ('queued','running','waiting_child')`
      )
      .get(conversationId)
  ) {
    throw new Error('SESSION_BUSY：会话正在执行 Agent 任务')
  }
}

function softDeleteConversation(db, id) {
  assertNoActiveRun(db, id)
  if (
    db
      .prepare(
        `SELECT 1 FROM messages WHERE conversation_id=? AND deleted_at IS NULL AND status='streaming'`
      )
      .get(id)
  ) {
    throw new Error('SESSION_BUSY：会话正在生成回复')
  }
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
  assertNoActiveRun(db, cur.conversationId)
  if (cur.status === 'streaming') throw new Error('SESSION_BUSY：回复还在生成')
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
// Run 状态机（方案四 §5.1）：终态不可逆；重试必须创建新 Run，不得原地重启。
const RUN_TERMINAL = ['done', 'stopped', 'error', 'max_steps', 'transferred', 'interrupted']
const RUN_ACTIVE = ['queued', 'running', 'waiting_child']
// 允许的来源状态；未列出的转换一律拒绝。只约束本产品写库，不假设任务必经每个中间态。
const RUN_NEXT = {
  queued: ['running', 'stopped', 'error'],
  running: ['waiting_child', 'done', 'stopped', 'error', 'max_steps', 'transferred', 'interrupted'],
  waiting_child: ['running', 'stopped', 'error', 'interrupted']
}

const RUN_COLUMNS = `id, conversation_id AS conversationId, goal, status,
  max_steps AS maxSteps, steps_used AS stepsUsed, started_at AS startedAt, ended_at AS endedAt,
  parent_run_id AS parentRunId, control_mode AS controlMode, mandate_json AS mandateJson,
  acceptance_policy AS acceptancePolicy, acceptance_status AS acceptanceStatus,
  acceptance_result AS acceptanceResult, trace_id AS traceId,
  idempotency_key AS idempotencyKey, version, submitted_at AS submittedAt,
  claimed_at AS claimedAt, finished_reason AS finishedReason, user_message_id AS userMessageId,
  assistant_message_id AS assistantMessageId, transfer_to_run_id AS transferToRunId, run_spec_json AS runSpecJson`

function isRunTerminal(status) {
  return RUN_TERMINAL.includes(status)
}

function getRun(db, id) {
  return db.prepare(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE id = ?`).get(id)
}

// 创建 Run。根 Run：parentRunId/controlMode 为空。子 Run：必须成对给出。
// idempotencyKey 相同则返回既有 Run，不重复创建（方案四 §6.3）。
function createRun(db, opts = {}) {
  const {
    conversationId,
    goal,
    maxSteps,
    parentRunId = null,
    controlMode = null,
    mandate = null,
    acceptancePolicy = null,
    traceId = null,
    idempotencyKey = null,
    status = 'running'
  } = opts

  if (!!parentRunId !== !!controlMode) {
    throw new Error('parentRunId 与 controlMode 必须同时提供或同时为空')
  }
  if (controlMode && !['delegated', 'transferred'].includes(controlMode)) {
    throw new Error(`非法的 controlMode: ${controlMode}`)
  }
  if (idempotencyKey) {
    const existing = db
      .prepare('SELECT id FROM agent_runs WHERE idempotency_key = ?')
      .get(idempotencyKey)
    // 幂等命中：直接返回既有 Run id，调用方无需区分（方案四 §6.3）
    if (existing) return existing.id
  }

  const id = uid()
  db.prepare(
    `INSERT INTO agent_runs(id, conversation_id, goal, status, max_steps, steps_used,
      started_at, parent_run_id, control_mode, mandate_json, acceptance_policy,
      trace_id, idempotency_key, version)
     VALUES(?,?,?,?,?,0,?,?,?,?,?,?,?,1)`
  ).run(
    id,
    conversationId || null,
    goal,
    status,
    maxSteps || 15,
    now(),
    parentRunId,
    controlMode,
    mandate ? JSON.stringify(mandate) : null,
    acceptancePolicy ? JSON.stringify(acceptancePolicy) : null,
    traceId,
    idempotencyKey
  )
  return id
}

// 需要知道是否命中幂等的调用方使用此版本
function createRunEx(db, opts = {}) {
  const before = opts.idempotencyKey
    ? db.prepare('SELECT id FROM agent_runs WHERE idempotency_key = ?').get(opts.idempotencyKey)
    : null
  const id = createRun(db, opts)
  return { id, reused: !!(before && before.id === id) }
}

// 原子状态更新：带版本号 CAS + 来源状态白名单。
// 返回 { ok, run } —— ok=false 表示版本冲突/状态不允许，调用方不得覆盖。
function updateRunStatus(db, id, patch = {}) {
  const cur = getRun(db, id)
  if (!cur) return { ok: false, reason: 'not_found' }
  const next = patch.status
  if (!next) throw new Error('updateRunStatus 需要 status')

  if (isRunTerminal(cur.status)) {
    return { ok: false, reason: 'already_terminal', run: cur }
  }
  const allowed = RUN_NEXT[cur.status]
  if (!allowed || !allowed.includes(next)) {
    return { ok: false, reason: `illegal_transition:${cur.status}->${next}`, run: cur }
  }

  const expected = patch.expectedVersion ?? cur.version
  const info = db
    .prepare(
      `UPDATE agent_runs SET status=?, steps_used=?, ended_at=?, acceptance_status=COALESCE(?, acceptance_status),
       acceptance_result=COALESCE(?, acceptance_result), version=version+1
       WHERE id=? AND version=? AND status=?`
    )
    .run(
      next,
      patch.stepsUsed ?? cur.stepsUsed ?? 0,
      patch.endedAt ?? (isRunTerminal(next) ? now() : null),
      patch.acceptanceStatus ?? null,
      patch.acceptanceResult ? JSON.stringify(patch.acceptanceResult) : null,
      id,
      expected,
      cur.status
    )
  if (!info.changes) return { ok: false, reason: 'version_conflict', run: getRun(db, id) }
  return { ok: true, run: getRun(db, id) }
}

// 兼容旧调用点：终止类状态走 CAS，失败只记录不抛（旧代码期望 void）。
function updateRun(db, id, patch) {
  if (patch.status) {
    const r = updateRunStatus(db, id, patch)
    if (!r.ok) {
      // 不静默：把被拒绝的写入打到 stderr，供审计排查
      console.error('MINIAGENT_RUN_UPDATE_REJECTED', id, r.reason)
    }
    return r.ok
  }
  // 仅更新 stepsUsed 等非状态字段时保持原行为
  db.prepare('UPDATE agent_runs SET steps_used=?, ended_at=?, version=version+1 WHERE id=?').run(
    patch.stepsUsed ?? 0,
    patch.endedAt ?? null,
    id
  )
  return true
}

// 委派收口：delegated 子 Run 终态后，把仍在 waiting_child 的父 Run 唤醒。
// transferred 是终态移交，父 Run 不应再恢复。
function resumeParentAfterChild(db, childRunId) {
  const child = getRun(db, childRunId)
  if (!child || !child.parentRunId) return { resumed: false, reason: 'no_parent' }
  if (child.controlMode !== 'delegated') return { resumed: false, reason: 'not_delegated' }
  if (!isRunTerminal(child.status)) return { resumed: false, reason: 'child_not_terminal' }
  const parent = getRun(db, child.parentRunId)
  if (!parent) return { resumed: false, reason: 'parent_not_found' }
  if (parent.status !== 'waiting_child') return { resumed: false, reason: 'parent_not_waiting' }
  // 单活动子 Run 约束的兜底：还有别的活动子 Run 时不能提前唤醒父任务
  if (listActiveChildRuns(db, parent.id).length) {
    return { resumed: false, reason: 'other_children_active', parentRunId: parent.id }
  }
  const r = updateRunStatus(db, parent.id, { status: 'running' })
  return r.ok
    ? { resumed: true, parentRunId: parent.id }
    : { resumed: false, reason: r.reason, parentRunId: parent.id }
}

// 终态收口：允许 waiting_child → running → 终态。
// 用于父 Run 尚未等待子 Run 就自行结束的场景，避免状态永久卡在 waiting_child。
function finalizeRunStatus(db, id, patch = {}) {
  if (!isRunTerminal(patch.status)) return updateRunStatus(db, id, patch)
  const first = updateRunStatus(db, id, patch)
  if (first.ok) return first
  if (first.reason !== `illegal_transition:waiting_child->${patch.status}`) return first
  const resumed = updateRunStatus(db, id, { status: 'running' })
  if (!resumed.ok) return first
  return updateRunStatus(db, id, patch)
}

// 列出某父 Run 的活动子 Run（用于"同时最多一个活动子 Run"约束）
function listActiveChildRuns(db, parentRunId) {
  const marks = RUN_ACTIVE.map(() => '?').join(',')
  return db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM agent_runs
       WHERE parent_run_id = ? AND status IN (${marks})`
    )
    .all(parentRunId, ...RUN_ACTIVE)
}

function listChildRuns(db, parentRunId) {
  return db
    .prepare(`SELECT ${RUN_COLUMNS} FROM agent_runs WHERE parent_run_id = ? ORDER BY started_at`)
    .all(parentRunId)
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
  PERMISSION_MODES,
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
  listChildConversations,
  listAgentConversations,
  updateConversation,
  touchConversation,
  softDeleteConversation,
  assertNoActiveRun,
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
  createRunEx,
  updateRun,
  updateRunStatus,
  finalizeRunStatus,
  resumeParentAfterChild,
  getRun,
  listActiveChildRuns,
  listChildRuns,
  isRunTerminal,
  RUN_TERMINAL,
  RUN_ACTIVE,
  logToolCall,
  listRuns,
  getRunCalls
}
