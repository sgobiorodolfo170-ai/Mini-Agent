// 旧库升级路径的回归测试。
// 背景：曾经把 `CREATE INDEX idx_conv_parent ON conversations(parent_id)` 放进 SCHEMA_SQL，
// 而 SCHEMA_SQL 在补列之前执行，导致真实 v3 库升级时直接抛 `no such column: parent_id`，
// 应用启动即失败。`:memory:` 每次都按最新建表语句新建，覆盖不到这条路径，所以这里
// 手工造一个 v3 形态的库文件再走 migrate。
import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import dbm from '../../electron/store/db'

let dir
let dbPath

// v3 时代的表结构（只保留迁移逻辑会读写的列，其余列由 SCHEMA_SQL 的 IF NOT EXISTS 补齐）
const V3_SQL = `
CREATE TABLE kbs (
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
CREATE TABLE conversations (
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
CREATE TABLE agent_runs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT,
  goal TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running',
  max_steps INTEGER NOT NULL DEFAULT 15,
  steps_used INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);
PRAGMA user_version = 3;
`

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-migrate-'))
  dbPath = path.join(dir, 'miniagent.db')
  dbm.close()
  const { DatabaseSync } = require('node:sqlite')
  const legacy = new DatabaseSync(dbPath)
  legacy.exec(V3_SQL)
  legacy
    .prepare(
      'INSERT INTO conversations (id, title, created_at, updated_at, project_id) VALUES (?,?,?,?,?)'
    )
    .run('c-legacy', '老会话', 1, 2, 'p1')
  legacy
    .prepare('INSERT INTO agent_runs (id, conversation_id, goal, started_at) VALUES (?,?,?,?)')
    .run('r-legacy', 'c-legacy', '老目标', 3)
  legacy.close()
})

afterEach(() => {
  dbm.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('旧库迁移', () => {
  it('v3 库能升级到最新版本并保留既有数据', () => {
    const db = dbm.open(dbPath)

    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(dbm.SCHEMA_VERSION)

    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get('c-legacy')
    expect(conv.title).toBe('老会话')
    expect(conv.project_id).toBe('p1')
    // 新增列带默认值，旧行自动归为人工会话
    expect(conv.origin).toBe('user')
    expect(conv.parent_id).toBeNull()
    expect(conv.created_by_run).toBeNull()

    const run = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get('r-legacy')
    expect(run.goal).toBe('老目标')
    expect(run.acceptance_status).toBe('not_required')
    expect(run.version).toBe(1)

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all()
      .map((r) => r.name)
    expect(indexes).toContain('idx_conv_parent')
  })

  it('迁移后再次打开是幂等的', () => {
    dbm.open(dbPath)
    dbm.close()
    const db = dbm.open(dbPath)
    expect(db.prepare('PRAGMA user_version').get().user_version).toBe(dbm.SCHEMA_VERSION)
    expect(db.prepare('SELECT COUNT(*) AS c FROM conversations').get().c).toBe(1)
  })
})
