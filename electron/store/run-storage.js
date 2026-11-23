const fs = require('fs')
const { transaction } = require('../main/remote/protocol')
const { redact } = require('../main/runtime-log')

const MAX_CHECKPOINT_BYTES = 256 * 1024

const RUN_SCHEMA = `
CREATE TABLE IF NOT EXISTS run_dispatch_requests (
  scope TEXT NOT NULL, request_key TEXT NOT NULL, fingerprint TEXT NOT NULL,
  run_ids TEXT NOT NULL, PRIMARY KEY(scope, request_key)
);
CREATE TABLE IF NOT EXISTS run_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL,
  status TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_runs_managed_session
  ON agent_runs(conversation_id)
  WHERE run_spec_json IS NOT NULL AND status IN ('queued','running','waiting_child');
CREATE INDEX IF NOT EXISTS idx_agent_runs_managed_queue
  ON agent_runs(status, submitted_at, id) WHERE run_spec_json IS NOT NULL;
`

function recordRunState(db, id) {
  db.prepare(
    `INSERT INTO run_events(run_id,status,version,created_at)
    SELECT id,status,version,? FROM agent_runs WHERE id=?`
  ).run(Date.now(), id)
}

function trimCheckpointMessages(messages) {
  const list = (Array.isArray(messages) ? messages : []).map((m) => ({
    role: m.role,
    content: String(m.content == null ? '' : m.content).slice(0, 20000),
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}),
    ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {})
  }))
  let json = redact(JSON.stringify(list))
  // 先丢最旧的工具结果，并同步移除对应调用，保留 system 与最近上下文。
  while (Buffer.byteLength(json) > MAX_CHECKPOINT_BYTES && list.length > 3) {
    const toolIndex = list.findIndex((m, index) => index > 0 && m.role === 'tool')
    if (toolIndex < 0) break
    const toolCallId = list[toolIndex].tool_call_id
    list.splice(toolIndex, 1)
    for (let index = list.length - 1; index >= 0; index--) {
      const message = list[index]
      if (!Array.isArray(message.tool_calls)) continue
      message.tool_calls = message.tool_calls.filter((call) => call.id !== toolCallId)
      if (!message.tool_calls.length) delete message.tool_calls
      if (message.role === 'assistant' && !message.content && !message.tool_calls)
        list.splice(index, 1)
    }
    json = redact(JSON.stringify(list))
  }
  if (Buffer.byteLength(json) > MAX_CHECKPOINT_BYTES) return null
  return list
}

function saveCheckpoint(db, runId, snapshot = {}) {
  try {
    const messages = trimCheckpointMessages(snapshot.messages)
    if (!messages) return false
    const pending = Array.isArray(snapshot.pendingToolCalls) ? snapshot.pendingToolCalls : []
    db.prepare(
      `INSERT INTO run_checkpoints(run_id,seq,phase,step,messages_json,pending_tools_json,
       steps_used,created_at) VALUES(?,1,?,?,?,?,?,?)
       ON CONFLICT(run_id) DO UPDATE SET
         seq=run_checkpoints.seq+1,
         phase=excluded.phase,
         step=excluded.step,
         messages_json=excluded.messages_json,
         pending_tools_json=excluded.pending_tools_json,
         steps_used=excluded.steps_used,
         created_at=excluded.created_at`
    ).run(
      runId,
      String(snapshot.phase || 'before_model'),
      Number(snapshot.step) || 0,
      redact(JSON.stringify(messages)),
      pending.length ? redact(JSON.stringify(pending)) : null,
      Number(snapshot.stepsUsed) || 0,
      Date.now()
    )
    return true
  } catch {
    return false
  }
}

function loadCheckpoint(db, runId) {
  const row = db.prepare('SELECT * FROM run_checkpoints WHERE run_id=?').get(runId)
  if (!row) return null
  let messages = []
  try {
    messages = JSON.parse(row.messages_json)
  } catch {
    return null
  }
  if (!Array.isArray(messages)) return null
  let pendingTools = []
  try {
    pendingTools = row.pending_tools_json ? JSON.parse(row.pending_tools_json) : []
  } catch {
    pendingTools = []
  }
  return {
    phase: row.phase,
    step: row.step,
    messages,
    pendingTools: Array.isArray(pendingTools) ? pendingTools : [],
    stepsUsed: row.steps_used,
    createdAt: row.created_at
  }
}

function clearCheckpoint(db, runId) {
  try {
    db.prepare('DELETE FROM run_checkpoints WHERE run_id=?').run(runId)
  } catch {
    // 清理失败不影响终态
  }
}

// 只恢复安全边界：模型调用前或工具全部完成；未知副作用一律不重放。
function autoResumeRuns(db) {
  const rows = db
    .prepare(
      `SELECT id, assistant_message_id AS assistantMessageId, max_steps AS maxSteps,
        workspace_json AS workspaceJson, run_spec_json AS runSpecJson
       FROM agent_runs WHERE status='interrupted' AND resume_count<1`
    )
    .all()
  const resumed = []
  for (const row of rows) {
    if (!row.runSpecJson) continue
    const cp = loadCheckpoint(db, row.id)
    if (!cp) continue
    if (!['before_model', 'tool_done'].includes(cp.phase)) continue
    if (!cp.messages.length || cp.pendingTools.length) continue
    if (cp.stepsUsed >= (Number(row.maxSteps) || 15)) continue
    const unfinished = db
      .prepare(
        "SELECT 1 FROM agent_tool_calls WHERE run_id=? AND status IN ('started','unknown') LIMIT 1"
      )
      .get(row.id)
    if (unfinished) continue
    let workspace = null
    try {
      workspace = row.workspaceJson ? JSON.parse(row.workspaceJson) : null
    } catch {
      workspace = null
    }
    if (workspace && workspace.mode === 'worktree' && !fs.existsSync(workspace.path)) continue

    const info = db
      .prepare(
        `UPDATE agent_runs SET status='queued', finished_reason=NULL, ended_at=NULL,
         resume_count=resume_count+1, version=version+1
         WHERE id=? AND status='interrupted' AND resume_count<1`
      )
      .run(row.id)
    if (!info.changes) continue
    if (row.assistantMessageId) {
      db.prepare("UPDATE messages SET status='pending' WHERE id=?").run(row.assistantMessageId)
    }
    recordRunState(db, row.id)
    resumed.push(row.id)
  }
  return resumed
}

function blockOrphanDependents(db) {
  transaction(db, () => {
    for (let pass = 0; pass < 20; pass++) {
      const blocked = db
        .prepare(
          `UPDATE agent_runs SET status='stopped', finished_reason='dependency_failed',
             ended_at=COALESCE(ended_at,?), version=version+1
           WHERE status='queued' AND id IN (
             SELECT d.run_id FROM run_dependencies d
             JOIN agent_runs p ON p.id=d.depends_on_run_id
             WHERE p.status IN ('error','stopped','interrupted','max_steps','transferred')
           )
           RETURNING id, assistant_message_id AS assistantMessageId`
        )
        .all(Date.now())
      if (!blocked.length) return
      for (const row of blocked) {
        if (row.assistantMessageId) {
          db.prepare("UPDATE messages SET status='stopped' WHERE id=?").run(row.assistantMessageId)
        }
        recordRunState(db, row.id)
      }
    }
  })
}

function stopOrphanDependents(db) {
  transaction(db, () => {
    const stopped = db
      .prepare(
        `
      WITH RECURSIVE lost(id) AS (
        SELECT child.id FROM agent_runs child JOIN agent_runs parent ON child.parent_run_id=parent.id
          WHERE child.status IN ('queued','transferred') AND child.control_mode='delegated'
            AND parent.status IN ('done','error','stopped','interrupted','max_steps')
        UNION
        SELECT child.id FROM agent_runs child JOIN lost ON child.parent_run_id=lost.id
          WHERE child.status IN ('queued','transferred')
      )
      UPDATE agent_runs SET
        finished_reason=CASE WHEN run_spec_json IS NULL THEN 'legacy_unrecoverable'
          WHEN status='queued' THEN 'parent_interrupted' ELSE 'app_restarted' END,
        status=CASE WHEN run_spec_json IS NULL OR status='queued' THEN 'stopped'
          ELSE 'interrupted' END,
        ended_at=COALESCE(ended_at,?), version=version+1
      WHERE id IN (SELECT id FROM lost) AND status IN ('queued','running','waiting_child')
      RETURNING id,assistant_message_id AS assistantMessageId,status
    `
      )
      .all(Date.now())
    for (const row of stopped) {
      if (row.assistantMessageId) {
        db.prepare('UPDATE messages SET status=? WHERE id=?').run(
          row.status === 'interrupted' ? 'interrupted' : 'stopped',
          row.assistantMessageId
        )
      }
      recordRunState(db, row.id)
    }
  })
}

function recoverRuns(db) {
  transaction(db, () => {
    const changed = db
      .prepare(
        `
      UPDATE agent_runs SET
        finished_reason=CASE WHEN run_spec_json IS NULL THEN 'legacy_unrecoverable'
          ELSE 'app_restarted' END,
        status=CASE WHEN run_spec_json IS NULL THEN 'stopped' ELSE 'interrupted' END,
        ended_at=COALESCE(ended_at,?), version=version+1
      WHERE status IN ('running','waiting_child')
        OR (status='queued' AND run_spec_json IS NULL)
      RETURNING id,assistant_message_id AS assistantMessageId,status
    `
      )
      .all(Date.now())
    for (const row of changed) {
      if (row.assistantMessageId) {
        db.prepare('UPDATE messages SET status=? WHERE id=?').run(
          row.status === 'interrupted' ? 'interrupted' : 'stopped',
          row.assistantMessageId
        )
      }
      recordRunState(db, row.id)
    }
    db.prepare("UPDATE messages SET status='stopped' WHERE status='streaming'").run()
    db.prepare(
      "UPDATE agent_approvals SET status='cancelled', decision_reason='app_restarted' WHERE status='pending'"
    ).run()
  })
  autoResumeRuns(db)
  stopOrphanDependents(db)
  blockOrphanDependents(db)
  // 图状态按恢复后的节点重新汇总；失败节点已在上面的循环中收口。
  try {
    const graph = require('../main/agent/graph')
    for (const row of db
      .prepare('SELECT DISTINCT graph_id AS id FROM agent_runs WHERE graph_id IS NOT NULL')
      .all()) {
      graph.refreshGraph(db, row.id)
    }
  } catch {
    // 图模块不可用时不影响启动恢复
  }
}

module.exports = {
  RUN_SCHEMA,
  MAX_CHECKPOINT_BYTES,
  recordRunState,
  saveCheckpoint,
  loadCheckpoint,
  clearCheckpoint,
  autoResumeRuns,
  blockOrphanDependents,
  recoverRuns
}
