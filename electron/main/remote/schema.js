// 远程控制数据表：与 Agent 主库同库迁移，禁止独立创建第二套任务事实。
const REMOTE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS remote_devices (
  device_id TEXT PRIMARY KEY, name TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('viewer','operator','approver')),
  secret_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','revoked')),
  auth_version INTEGER NOT NULL DEFAULT 1, ua_summary TEXT,
  created_at INTEGER NOT NULL, last_seen_at INTEGER, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS remote_pairing_tickets (
  ticket_id TEXT PRIMARY KEY, ticket_hash TEXT NOT NULL UNIQUE, request_id TEXT UNIQUE,
  device_name TEXT, status TEXT NOT NULL CHECK(status IN
    ('issued','awaiting_desktop','approved','consumed','rejected','expired','cancelled')),
  verification_code TEXT, requested_ip TEXT, created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL, decided_at INTEGER, consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS remote_sessions (
  session_hash TEXT PRIMARY KEY, device_id TEXT NOT NULL REFERENCES remote_devices(device_id),
  auth_version INTEGER NOT NULL, csrf_hash TEXT NOT NULL, created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, absolute_expires_at INTEGER NOT NULL, revoked_at INTEGER
);
CREATE TABLE IF NOT EXISTS remote_device_grants (
  device_id TEXT NOT NULL REFERENCES remote_devices(device_id), conversation_id TEXT NOT NULL,
  capabilities_json TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, conversation_id)
);
CREATE TABLE IF NOT EXISTS remote_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, epoch TEXT NOT NULL,
  conversation_id TEXT, run_id TEXT, type TEXT NOT NULL, payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_event_state (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id=1), epoch TEXT NOT NULL,
  oldest_available_seq INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_commands (
  device_id TEXT NOT NULL, request_id TEXT NOT NULL, command_type TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('accepted','completed','rejected','failed','interrupted_unknown')),
  result_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(device_id, request_id)
);
CREATE TABLE IF NOT EXISTS agent_approvals (
  approval_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, conversation_id TEXT NOT NULL,
  tool_call_id TEXT, tool TEXT NOT NULL, canonical_args TEXT NOT NULL, args_hash TEXT NOT NULL,
  risk_level TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','expired','cancelled','superseded')),
  version INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  decided_by TEXT, decided_at INTEGER, decision_reason TEXT
);
CREATE TABLE IF NOT EXISTS remote_run_controls (
  run_id TEXT PRIMARY KEY,
  control_state TEXT NOT NULL CHECK(control_state IN
    ('none','pause_requested','paused','resume_requested','stop_requested')),
  requested_by TEXT, reason TEXT, version INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS remote_audit_logs (
  audit_id INTEGER PRIMARY KEY AUTOINCREMENT, device_id TEXT, session_hash TEXT,
  actor TEXT NOT NULL, action TEXT NOT NULL, target_type TEXT, target_id TEXT,
  request_id TEXT, result TEXT NOT NULL, detail_json TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_remote_events_conv ON remote_events(conversation_id,seq);
CREATE INDEX IF NOT EXISTS idx_remote_sessions_device ON remote_sessions(device_id);
CREATE INDEX IF NOT EXISTS idx_remote_approvals_pending ON agent_approvals(status,expires_at);
CREATE INDEX IF NOT EXISTS idx_remote_audit_at ON remote_audit_logs(created_at);
`
module.exports = { REMOTE_SCHEMA_SQL }
