const fs = require('fs')
const path = require('path')

const { RUN_SCHEMA, recoverRuns } = require('./run-storage')
const SCHEMA_VERSION = 10

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  rotation_strategy TEXT NOT NULL DEFAULT 'failover',
  probe_interval_min INTEGER NOT NULL DEFAULT 30,
  probe_model TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  models TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL REFERENCES providers(id),
  label TEXT NOT NULL DEFAULT '',
  secret_enc TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'unknown',
  cooldown_until INTEGER,
  rate_count INTEGER NOT NULL DEFAULT 0,
  last_used_at INTEGER,
  last_error TEXT,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS key_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  result TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '新会话',
  pinned INTEGER NOT NULL DEFAULT 0,
  provider_id TEXT,
  model TEXT,
  system_prompt TEXT,
  context_policy TEXT NOT NULL DEFAULT '{}',
  project_id TEXT,
  permission TEXT NOT NULL DEFAULT 'default',
  origin TEXT NOT NULL DEFAULT 'user',
  parent_id TEXT,
  created_by_run TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,
  attachments TEXT,
  meta TEXT,
  status TEXT NOT NULL DEFAULT 'done',
  seq INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS kbs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  embed_source TEXT NOT NULL DEFAULT 'remote',
  embed_provider_id TEXT,
  embed_model TEXT,
  embed_quant TEXT,
  dim INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS kb_documents (
  id TEXT PRIMARY KEY,
  kb_id TEXT NOT NULL,
  path TEXT NOT NULL,
  title TEXT NOT NULL,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  hash TEXT NOT NULL,
  chunk_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE IF NOT EXISTS kb_chunks (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES kb_documents(id) ON DELETE CASCADE,
  kb_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  heading_path TEXT,
  text TEXT NOT NULL,
  token_count INTEGER
);
CREATE TABLE IF NOT EXISTS kb_embeddings (
  chunk_id TEXT PRIMARY KEY REFERENCES kb_chunks(id) ON DELETE CASCADE,
  kb_id TEXT NOT NULL,
  dim INTEGER NOT NULL,
  embedding BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  max_steps INTEGER NOT NULL DEFAULT 15,
  steps_used INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS agent_tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  tool TEXT NOT NULL,
  args TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  result TEXT,
  error TEXT,
  duration_ms INTEGER,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_chunks_doc ON kb_chunks(document_id);
CREATE INDEX IF NOT EXISTS idx_emb_kb ON kb_embeddings(kb_id);
`

function columnExists(db, table, col) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((r) => r.name === col)
}

function migrate(db) {
  const row = db.prepare('PRAGMA user_version').get()
  const current = Number(row && row.user_version) || 0
  if (current < SCHEMA_VERSION) {
    db.exec(SCHEMA_SQL)
    // v1 → v2:知识库支持本地嵌入（onnxruntime）。旧库的既有知识库视为远程嵌入来源。
    if (!columnExists(db, 'kbs', 'embed_source')) {
      db.exec("ALTER TABLE kbs ADD COLUMN embed_source TEXT NOT NULL DEFAULT 'remote'")
    }
    if (!columnExists(db, 'kbs', 'embed_quant')) {
      db.exec('ALTER TABLE kbs ADD COLUMN embed_quant TEXT')
    }
    // v2 → v3:项目工作目录。会话可归入项目，Agent 命令在项目目录内执行。
    if (!columnExists(db, 'conversations', 'project_id')) {
      db.exec('ALTER TABLE conversations ADD COLUMN project_id TEXT')
    }
    // v3 → v4:Agent 会话管理。origin 区分人工会话(user)与 Agent 创建的子会话(agent)，
    // parent_id / created_by_run 记录派生关系，便于按运行回溯与级联查看。
    if (!columnExists(db, 'conversations', 'origin')) {
      db.exec("ALTER TABLE conversations ADD COLUMN origin TEXT NOT NULL DEFAULT 'user'")
    }
    if (!columnExists(db, 'conversations', 'parent_id')) {
      db.exec('ALTER TABLE conversations ADD COLUMN parent_id TEXT')
    }
    if (!columnExists(db, 'conversations', 'created_by_run')) {
      db.exec('ALTER TABLE conversations ADD COLUMN created_by_run TEXT')
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_conv_parent ON conversations(parent_id)')
    // v4 → v5:任务级关系模型（方案四）。关系/授权/验收/追踪归属于一次 Run，
    // conversations 只保留上下文与展示用的 parent_id，不承担任务控制语义。
    if (!columnExists(db, 'agent_runs', 'parent_run_id')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN parent_run_id TEXT')
    }
    if (!columnExists(db, 'agent_runs', 'control_mode')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN control_mode TEXT')
    }
    if (!columnExists(db, 'agent_runs', 'mandate_json')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN mandate_json TEXT')
    }
    if (!columnExists(db, 'agent_runs', 'acceptance_policy')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN acceptance_policy TEXT')
    }
    if (!columnExists(db, 'agent_runs', 'acceptance_status')) {
      db.exec(
        "ALTER TABLE agent_runs ADD COLUMN acceptance_status TEXT NOT NULL DEFAULT 'not_required'"
      )
    }
    if (!columnExists(db, 'agent_runs', 'acceptance_result')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN acceptance_result TEXT')
    }
    if (!columnExists(db, 'agent_runs', 'trace_id')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN trace_id TEXT')
    }
    if (!columnExists(db, 'agent_runs', 'idempotency_key')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN idempotency_key TEXT')
    }
    if (!columnExists(db, 'agent_runs', 'version')) {
      db.exec('ALTER TABLE agent_runs ADD COLUMN version INTEGER NOT NULL DEFAULT 1')
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_parent_run_id ON agent_runs(parent_run_id)')
    db.exec('CREATE INDEX IF NOT EXISTS idx_agent_runs_trace_id ON agent_runs(trace_id)')
    // 幂等键唯一：同一 key 最多对应一个 Run（NULL 不受约束）
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_idempotency_key ON agent_runs(idempotency_key) WHERE idempotency_key IS NOT NULL'
    )
    // v5 → v6:项目支持置顶（置顶的项目分组排在项目区最前）
    if (!columnExists(db, 'projects', 'pinned')) {
      db.exec('ALTER TABLE projects ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0')
    }
    // v6 → v7:权限分级四级。会话记忆上次权限级别，切回会话时恢复。
    if (!columnExists(db, 'conversations', 'permission')) {
      db.exec("ALTER TABLE conversations ADD COLUMN permission TEXT NOT NULL DEFAULT 'default'")
    }
    // v7 → v8：局域网远程控制、持久审批与事件恢复。先完成旧列迁移再建远程索引。
    require('../main/remote/schema').REMOTE_SCHEMA_SQL
    db.exec(require('../main/remote/schema').REMOTE_SCHEMA_SQL)
    if (current < 9) {
      const { transaction } = require('../main/remote/protocol')
      transaction(db, () => {
        for (const [name, type] of Object.entries({
          submitted_at: 'INTEGER',
          claimed_at: 'INTEGER',
          finished_reason: 'TEXT',
          user_message_id: 'TEXT',
          assistant_message_id: 'TEXT',
          transfer_to_run_id: 'TEXT',
          run_spec_json: 'TEXT'
        })) {
          if (!columnExists(db, 'agent_runs', name))
            db.exec(`ALTER TABLE agent_runs ADD COLUMN ${name} ${type}`)
        }
        for (const [column, role, key] of [
          ['user_message_id', 'user', 'runId'],
          ['assistant_message_id', 'assistant', 'agentRunId']
        ]) {
          db.exec(`UPDATE agent_runs SET ${column}=(SELECT CASE WHEN COUNT(*)=1 THEN MAX(m.id) END
            FROM messages m WHERE m.conversation_id=agent_runs.conversation_id AND m.role='${role}'
              AND json_extract(CASE WHEN json_valid(m.meta) THEN m.meta END,'$.${key}')=agent_runs.id)`)
        }
        db.exec(`UPDATE agent_runs SET transfer_to_run_id=(SELECT CASE WHEN COUNT(*)=1 THEN MAX(child.id) END
          FROM agent_runs child WHERE child.parent_run_id=agent_runs.id AND child.control_mode='transferred')
          WHERE status='transferred'`)
        db.exec(RUN_SCHEMA)
        db.exec(`PRAGMA user_version = 9`)
      })
    }
    if (current < 10) {
      const { transaction } = require('../main/remote/protocol')
      transaction(db, () => {
        for (const [table, columns] of Object.entries({
          agent_runs: {
            graph_id: 'TEXT',
            node_key: 'TEXT',
            workspace_json: 'TEXT',
            resume_count: 'INTEGER NOT NULL DEFAULT 0'
          },
          agent_tool_calls: {
            call_id: 'TEXT',
            status: "TEXT NOT NULL DEFAULT 'done'",
            started_at: 'INTEGER',
            finished_at: 'INTEGER'
          },
          projects: {
            workspace_mode: "TEXT NOT NULL DEFAULT 'worktree'",
            workspace_auto_merge: 'INTEGER NOT NULL DEFAULT 1'
          }
        })) {
          for (const [name, type] of Object.entries(columns)) {
            if (!columnExists(db, table, name))
              db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
          }
        }
        db.exec(`
CREATE TABLE IF NOT EXISTS run_graphs (
  id TEXT PRIMARY KEY,
  parent_run_id TEXT,
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE TABLE IF NOT EXISTS run_dependencies (
  run_id TEXT NOT NULL,
  depends_on_run_id TEXT NOT NULL,
  PRIMARY KEY (run_id, depends_on_run_id)
);
CREATE TABLE IF NOT EXISTS run_checkpoints (
  run_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL DEFAULT 0,
  phase TEXT NOT NULL,
  step INTEGER NOT NULL DEFAULT 0,
  messages_json TEXT NOT NULL,
  pending_tools_json TEXT,
  steps_used INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_graph ON agent_runs(graph_id);
CREATE INDEX IF NOT EXISTS idx_run_deps_dep ON run_dependencies(depends_on_run_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_call ON agent_tool_calls(run_id, call_id);
`)
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      })
    }
  }
}

// Singleton DB handle. Backed by globalThis so the instance survives module
// duplication in test runners (vite-node externalization) — in production the
// main process is a single realm anyway.
function open(dbPath) {
  if (globalThis.__miniagentDB) return globalThis.__miniagentDB
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const { DatabaseSync } = require('node:sqlite')
  const db = new DatabaseSync(dbPath)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  recoverRuns(db)
  globalThis.__miniagentDB = db
  globalThis.__miniagentDBInfo = { path: dbPath, driver: 'node:sqlite' }
  return db
}

function get() {
  if (!globalThis.__miniagentDB) throw new Error('database not opened')
  return globalThis.__miniagentDB
}

function close() {
  if (globalThis.__miniagentDB) {
    globalThis.__miniagentDB.close()
    globalThis.__miniagentDB = null
    globalThis.__miniagentDBInfo = null
  }
}

function info() {
  return globalThis.__miniagentDBInfo
}

module.exports = { open, get, close, info, SCHEMA_VERSION, SCHEMA_SQL, columnExists }
