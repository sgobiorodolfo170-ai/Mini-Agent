const fs = require('fs')

// Full backup export/import. Crypto functions are injected so this stays testable
// (electron safeStorage is unavailable under vitest).
const TABLES = [
  'kb_embeddings',
  'kb_chunks',
  'kb_documents',
  'kbs',
  'messages',
  'conversations',
  'projects',
  'agent_tool_calls',
  'agent_runs',
  'key_events',
  'api_keys',
  'providers',
  'settings'
]

async function exportAll(db, destPath, { includeKeys = false, decryptSecret = (s) => s } = {}) {
  const q = (sql, ...args) => db.prepare(sql).all(...args)
  const providers = q('SELECT * FROM providers WHERE deleted_at IS NULL')
  const keys = q('SELECT * FROM api_keys WHERE deleted_at IS NULL')
  const conversations = q('SELECT * FROM conversations WHERE deleted_at IS NULL')
  const projects = q('SELECT * FROM projects WHERE deleted_at IS NULL')
  const messages = q('SELECT * FROM messages WHERE deleted_at IS NULL')
  const kbs = q('SELECT * FROM kbs WHERE deleted_at IS NULL')
  const docs = q('SELECT * FROM kb_documents WHERE deleted_at IS NULL')
  const chunks = q('SELECT * FROM kb_chunks')
  const embeddings = q('SELECT chunk_id, kb_id, dim, embedding FROM kb_embeddings').map((r) => ({
    chunk_id: r.chunk_id,
    kb_id: r.kb_id,
    dim: r.dim,
    embedding_b64: Buffer.from(r.embedding).toString('base64')
  }))
  const runs = q('SELECT * FROM agent_runs')
  const calls = q('SELECT * FROM agent_tool_calls')
  const keyEvents = q('SELECT * FROM key_events')

  const data = {
    app: 'miniagent',
    version: 1,
    exportedAt: Date.now(),
    settings: Object.fromEntries(
      q('SELECT key, value FROM settings').map((r) => {
        try {
          return [r.key, JSON.parse(r.value)]
        } catch {
          return [r.key, r.value]
        }
      })
    ),
    providers,
    keys: keys.map(({ secret_enc, ...rest }) => ({ ...rest, hasSecret: !!secret_enc })),
    secrets: includeKeys
      ? await Promise.all(
          keys.map(async (k) => ({ id: k.id, secret: await decryptSecret(k.secret_enc) }))
        )
      : [],
    conversations,
    projects,
    messages,
    kbs,
    docs,
    chunks,
    embeddings,
    runs,
    calls,
    keyEvents
  }
  fs.writeFileSync(destPath, JSON.stringify(data), 'utf8')
  return {
    path: destPath,
    providers: providers.length,
    keys: keys.length,
    secrets: data.secrets.length,
    conversations: conversations.length,
    projects: projects.length,
    messages: messages.length,
    kbs: kbs.length,
    docs: docs.length,
    chunks: chunks.length
  }
}

async function importAll(db, srcPath, { encryptSecret = (s) => s } = {}) {
  const raw = fs.readFileSync(srcPath, 'utf8')
  const data = JSON.parse(raw)
  if (!data || data.app !== 'miniagent' || !data.version) {
    throw new Error('不是有效的 miniagent 备份文件')
  }
  const secretById = new Map((data.secrets || []).map((s) => [s.id, s.secret]))
  const encryptedById = new Map()
  for (const s of data.secrets || []) {
    encryptedById.set(s.id, await encryptSecret(s.secret))
  }
  db.exec('BEGIN')
  try {
    for (const t of TABLES) db.exec(`DELETE FROM ${t}`)
    const ins = (table, cols, rows) => {
      if (!rows || !rows.length) return 0
      const stmt = db.prepare(
        `INSERT INTO ${table}(${cols.join(',')}) VALUES(${cols.map(() => '?').join(',')})`
      )
      for (const r of rows) stmt.run(...cols.map((c) => (r[c] === undefined ? null : r[c])))
      return rows.length
    }
    ins(
      'settings',
      ['key', 'value'],
      Object.entries(data.settings || {}).map(([key, value]) => ({
        key,
        value: JSON.stringify(value)
      }))
    )
    ins(
      'providers',
      [
        'id',
        'name',
        'base_url',
        'rotation_strategy',
        'probe_interval_min',
        'probe_model',
        'enabled',
        'models',
        'created_at',
        'updated_at',
        'deleted_at'
      ],
      data.providers || []
    )
    ins('key_events', ['id', 'api_key_id', 'kind', 'result', 'detail', 'at'], data.keyEvents || [])
    ins(
      'api_keys',
      [
        'id',
        'provider_id',
        'label',
        'secret_enc',
        'status',
        'cooldown_until',
        'rate_count',
        'last_used_at',
        'last_error',
        'sort',
        'created_at',
        'updated_at',
        'deleted_at'
      ],
      (data.keys || []).map((k) => ({
        ...k,
        secret_enc: secretById.has(k.id) ? encryptedById.get(k.id) || '' : ''
      }))
    )
    ins(
      'projects',
      ['id', 'name', 'path', 'sort', 'created_at', 'updated_at', 'deleted_at'],
      data.projects || []
    )
    ins(
      'conversations',
      [
        'id',
        'title',
        'pinned',
        'provider_id',
        'model',
        'system_prompt',
        'context_policy',
        'project_id',
        'created_at',
        'updated_at',
        'deleted_at'
      ],
      data.conversations || []
    )
    ins(
      'messages',
      [
        'id',
        'conversation_id',
        'role',
        'content',
        'tool_calls',
        'attachments',
        'meta',
        'status',
        'seq',
        'created_at',
        'updated_at',
        'deleted_at'
      ],
      data.messages || []
    )
    ins(
      'kbs',
      [
        'id',
        'name',
        'embed_source',
        'embed_provider_id',
        'embed_model',
        'embed_quant',
        'dim',
        'created_at',
        'updated_at',
        'deleted_at'
      ],
      data.kbs || []
    )
    ins(
      'kb_documents',
      [
        'id',
        'kb_id',
        'path',
        'title',
        'mime',
        'size',
        'hash',
        'chunk_count',
        'status',
        'error',
        'created_at',
        'updated_at',
        'deleted_at'
      ],
      data.docs || []
    )
    ins(
      'kb_chunks',
      ['id', 'document_id', 'kb_id', 'seq', 'heading_path', 'text', 'token_count'],
      data.chunks || []
    )
    for (const e of data.embeddings || []) {
      db.prepare('INSERT INTO kb_embeddings(chunk_id, kb_id, dim, embedding) VALUES(?,?,?,?)').run(
        e.chunk_id,
        e.kb_id,
        e.dim,
        Buffer.from(e.embedding_b64, 'base64')
      )
    }
    ins(
      'agent_runs',
      [
        'id',
        'conversation_id',
        'goal',
        'status',
        'max_steps',
        'steps_used',
        'started_at',
        'ended_at'
      ],
      data.runs || []
    )
    ins(
      'agent_tool_calls',
      [
        'id',
        'run_id',
        'step',
        'tool',
        'args',
        'risk_level',
        'confirmed_by',
        'result',
        'error',
        'duration_ms',
        'at'
      ],
      data.calls || []
    )
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
  return {
    providers: (data.providers || []).length,
    conversations: (data.conversations || []).length,
    messages: (data.messages || []).length,
    kbs: (data.kbs || []).length,
    keysWithSecret: (data.secrets || []).length
  }
}

module.exports = { exportAll, importAll }
