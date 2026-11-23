const { transaction } = require('../main/remote/protocol')

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

function recoverRuns(db) {
  transaction(db, () => {
    const changed = db
      .prepare(
        `
      WITH RECURSIVE lost(id) AS (
        SELECT id FROM agent_runs WHERE status IN ('running','waiting_child')
          OR (status='queued' AND run_spec_json IS NULL)
        UNION
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
    for (const row of changed) {
      if (row.assistantMessageId) {
        db.prepare('UPDATE messages SET status=? WHERE id=?').run(
          row.status === 'interrupted' ? 'interrupted' : 'stopped',
          row.assistantMessageId
        )
      }
      recordRunState(db, row.id)
    }
    // 依赖已失败的 queued 节点在重启后不能继续等：逐层收口，避免永久卡住。
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
      if (!blocked.length) break
      for (const row of blocked) {
        if (row.assistantMessageId) {
          db.prepare("UPDATE messages SET status='stopped' WHERE id=?").run(row.assistantMessageId)
        }
        recordRunState(db, row.id)
      }
    }
    db.prepare("UPDATE messages SET status='stopped' WHERE status='streaming'").run()
    db.prepare(
      "UPDATE agent_approvals SET status='cancelled', decision_reason='app_restarted' WHERE status='pending'"
    ).run()
  })
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

module.exports = { RUN_SCHEMA, recordRunState, recoverRuns }
