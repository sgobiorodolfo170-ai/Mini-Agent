const fs = require('fs')
const path = require('path')

const SCHEMA_VERSION = 3

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
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
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
  // Any 'streaming' message left over from a previous session is a zombie —
  // the app is starting fresh, no stream can still be attached to it (the
  // done update is lost when the process dies mid-stream). Mark them stopped.
  db.prepare("UPDATE messages SET status = 'stopped' WHERE status = 'streaming'").run()
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
