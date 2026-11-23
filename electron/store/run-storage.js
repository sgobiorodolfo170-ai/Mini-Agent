const fs = require('fs')
const { transaction, canonicalJson } = require('../main/remote/protocol')
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

function assessCheckpoint(db, runId, checkpoint) {
  if (!checkpoint) return { ok: false, reason: 'checkpoint_missing' }
  if (!checkpoint.messages.length) return { ok: false, reason: 'checkpoint_empty' }
  if (checkpoint.phase !== 'model_done') {
    if (!['before_model', 'tool_done'].includes(checkpoint.phase))
      return { ok: false, reason: 'unsafe_checkpoint' }
    if (checkpoint.pendingTools.length) return { ok: false, reason: 'pending_tools' }
    return { ok: true, checkpoint, recoveredCalls: [] }
  }

  const messages = checkpoint.messages
  const assistantIndex = messages.findLastIndex(
    (message) => message.role === 'assistant' && Array.isArray(message.tool_calls)
  )
  if (assistantIndex < 0) return { ok: false, reason: 'model_done_batch_missing' }
  const trailing = messages.slice(assistantIndex + 1)
  if (trailing.some((message) => message.role !== 'tool'))
    return { ok: false, reason: 'model_done_trailing_message' }
  const calls = messages[assistantIndex].tool_calls
  if (!calls.length) return { ok: false, reason: 'model_done_batch_empty' }
  const ids = calls.map((call) => call && call.id)
  if (ids.some((id) => typeof id !== 'string' || !id) || new Set(ids).size !== ids.length)
    return { ok: false, reason: 'model_done_call_id_invalid' }

  const existing = new Map()
  for (const message of trailing) {
    const id = message.tool_call_id
    if (!ids.includes(id) || existing.has(id))
      return { ok: false, reason: 'model_done_tool_message_conflict' }
    existing.set(id, message)
  }
  const expectedPending = calls.slice(existing.size).map((call) => call.id)
  const existingIds = [...existing.keys()]
  if (
    canonicalJson(existingIds) !==
    canonicalJson(calls.slice(0, existing.size).map((call) => call.id))
  )
    return { ok: false, reason: 'model_done_tool_order_conflict' }
  const pendingIds = checkpoint.pendingTools.map((call) => call && call.id)
  if (canonicalJson(pendingIds) !== canonicalJson(expectedPending))
    return { ok: false, reason: 'model_done_pending_mismatch' }

  const recoveredCalls = []
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]
    const message = existing.get(call.id)
    let parsedArgs = null
    try {
      parsedArgs = JSON.parse((call.function && call.function.arguments) || '{}')
    } catch {
      return { ok: false, reason: 'model_done_args_invalid' }
    }
    const rows = db
      .prepare(`SELECT * FROM agent_tool_calls WHERE run_id=? AND call_id=? ORDER BY id`)
      .all(runId, call.id)
    if (rows.length > 1) return { ok: false, reason: 'model_done_ledger_duplicate' }
    const ledger = rows[0]
    const name = call.function && call.function.name
    if (ledger) {
      if (!['done', 'failed'].includes(ledger.status) || !ledger.finished_at)
        return { ok: false, reason: 'model_done_tool_unsettled' }
      if (ledger.tool !== name) return { ok: false, reason: 'model_done_tool_mismatch' }
      let ledgerArgs = null
      try {
        ledgerArgs = JSON.parse(ledger.args)
      } catch {
        return { ok: false, reason: 'model_done_ledger_args_invalid' }
      }
      if (canonicalJson(ledgerArgs) !== canonicalJson(parsedArgs))
        return { ok: false, reason: 'model_done_args_mismatch' }
      if (ledger.status === 'failed' && !ledger.error)
        return { ok: false, reason: 'model_done_failure_incomplete' }
    }
    if (message) {
      if (ledger) {
        const expected = ledger.error
          ? `工具执行失败: ${ledger.error}`
          : String(ledger.result || '')
        if (String(message.content || '') !== expected)
          return { ok: false, reason: 'model_done_result_mismatch' }
      }
      continue
    }
    if (!ledger) return { ok: false, reason: 'model_done_tool_unsettled' }
    const content = ledger.error ? `工具执行失败: ${ledger.error}` : String(ledger.result || '')
    trailing.push({ role: 'tool', tool_call_id: call.id, content })
    recoveredCalls.push({ callId: call.id, tool: name, status: ledger.status })
  }

  return {
    ok: true,
    checkpoint: {
      ...checkpoint,
      phase: 'tool_done',
      messages: [...messages.slice(0, assistantIndex + 1), ...trailing],
      pendingTools: []
    },
    recoveredCalls
  }
}

function persistCheckpointRecovery(db, runId, assessment) {
  if (!assessment.ok || !assessment.recoveredCalls.length) return true
  return saveCheckpoint(db, runId, {
    phase: assessment.checkpoint.phase,
    step: assessment.checkpoint.step,
    messages: assessment.checkpoint.messages,
    pendingToolCalls: [],
    stepsUsed: assessment.checkpoint.stepsUsed
  })
}

function clearCheckpoint(db, runId) {
  try {
    db.prepare('DELETE FROM run_checkpoints WHERE run_id=?').run(runId)
  } catch {
    // 清理失败不影响终态
  }
}

function inspectInterruptedRun(db, runId) {
  const row = db
    .prepare(
      `SELECT id, status, parent_run_id AS parentRunId, graph_id AS graphId, max_steps AS maxSteps,
        workspace_json AS workspaceJson, run_spec_json AS runSpecJson
       FROM agent_runs WHERE id=?`
    )
    .get(runId)
  if (!row) return { exists: false, canResume: false, reason: 'not_found' }
  const parent = row.parentRunId
    ? db.prepare('SELECT status FROM agent_runs WHERE id=?').get(row.parentRunId)
    : null
  const checkpoint = row.runSpecJson ? loadCheckpoint(db, runId) : null
  const assessment = checkpoint ? assessCheckpoint(db, runId, checkpoint) : null
  const unfinishedTools = db
    .prepare(
      `SELECT id, tool, status, started_at AS startedAt
       FROM agent_tool_calls WHERE run_id=? AND status IN ('started','unknown') ORDER BY id`
    )
    .all(runId)
  let workspace = null
  let workspaceInvalid = false
  try {
    workspace = row.workspaceJson ? JSON.parse(row.workspaceJson) : null
  } catch {
    workspaceInvalid = true
    workspace = null
  }
  let reason = ''
  if (row.status !== 'interrupted') reason = 'not_interrupted'
  else if (!row.runSpecJson) reason = 'run_spec_missing'
  else if (row.parentRunId && (!parent || !['running', 'waiting_child'].includes(parent.status)))
    reason = 'parent_unavailable'
  else if (workspaceInvalid) reason = 'workspace_invalid'
  else if (!checkpoint) reason = 'checkpoint_missing'
  else if (!assessment.ok) reason = assessment.reason
  else if (unfinishedTools.length) reason = 'unfinished_tools'
  else if (checkpoint.stepsUsed >= (Number(row.maxSteps) || 15)) reason = 'max_steps_reached'
  else if (row.graphId) reason = 'graph_node_requires_retry'
  else if (workspace && workspace.mode === 'worktree' && !fs.existsSync(workspace.path))
    reason = 'workspace_missing'
  return {
    exists: true,
    canResume: !reason,
    reason: reason || null,
    checkpoint:
      assessment && assessment.ok
        ? {
            phase: assessment.checkpoint.phase,
            step: assessment.checkpoint.step,
            stepsUsed: assessment.checkpoint.stepsUsed,
            pendingTools: assessment.checkpoint.pendingTools
          }
        : null,
    recoveredCalls: assessment && assessment.ok ? assessment.recoveredCalls : [],
    unfinishedTools,
    workspace: workspace
      ? { mode: workspace.mode, path: workspace.path || '', branch: workspace.branch || '' }
      : null
  }
}

function requeueInterruptedRun(db, runId) {
  const inspection = inspectInterruptedRun(db, runId)
  if (!inspection.canResume) return { ok: false, reason: inspection.reason }
  const checkpoint = loadCheckpoint(db, runId)
  const assessment = assessCheckpoint(db, runId, checkpoint)
  if (!assessment.ok || !persistCheckpointRecovery(db, runId, assessment))
    return { ok: false, reason: assessment.ok ? 'checkpoint_write_failed' : assessment.reason }
  const row = db
    .prepare('SELECT assistant_message_id AS assistantMessageId FROM agent_runs WHERE id=?')
    .get(runId)
  const info = db
    .prepare(
      `UPDATE agent_runs SET status='queued', finished_reason=NULL, ended_at=NULL, claimed_at=NULL,
         resume_count=resume_count+1, version=version+1
       WHERE id=? AND status='interrupted'`
    )
    .run(runId)
  if (!info.changes) return { ok: false, reason: 'state_conflict' }
  if (row && row.assistantMessageId) {
    db.prepare("UPDATE messages SET status='pending' WHERE id=?").run(row.assistantMessageId)
  }
  recordRunState(db, runId)
  return { ok: true }
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
    const assessment = assessCheckpoint(db, row.id, cp)
    if (!assessment.ok) continue
    if (assessment.checkpoint.stepsUsed >= (Number(row.maxSteps) || 15)) continue
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
    if (!persistCheckpointRecovery(db, row.id, assessment)) continue

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
  inspectInterruptedRun,
  requeueInterruptedRun,
  autoResumeRuns,
  blockOrphanDependents,
  recoverRuns
}
