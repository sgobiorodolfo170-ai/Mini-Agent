const { createHash, randomUUID } = require('node:crypto')
const { transaction, canonicalJson, remoteError } = require('../remote/protocol')
const graph = require('./graph')
const { LIMITS } = require('./cluster-policy')

function fingerprint(tasks) {
  return createHash('sha256').update(canonicalJson(tasks)).digest('hex')
}

function planView(row) {
  if (!row) return null
  let tasks = []
  try {
    tasks = JSON.parse(row.spec_json)
  } catch {
    tasks = []
  }
  return {
    planId: row.id,
    parentRunId: row.parent_run_id,
    conversationId: row.conversation_id,
    status: row.status,
    tasks,
    etag: row.etag,
    graphId: row.graph_id,
    createdAt: row.created_at,
    confirmedAt: row.confirmed_at,
    limits: LIMITS
  }
}

function createDraft(
  db,
  { parentRunId, conversationId, tasks, requestKey = null, assertParent = () => {} }
) {
  const normalized = graph.validatePlan(tasks)
  const hash = fingerprint(normalized)
  return transaction(db, () => {
    if (requestKey) {
      const previous = db
        .prepare('SELECT * FROM cluster_plans WHERE parent_run_id=? AND request_key=?')
        .get(parentRunId, requestKey)
      if (previous) {
        if (previous.etag !== hash)
          throw remoteError('IDEMPOTENCY_CONFLICT', '计划请求编号已用于其他内容', 409)
        return planView(previous)
      }
    }
    assertParent()
    const id = `plan-${randomUUID()}`
    db.prepare(
      `INSERT INTO cluster_plans(id,parent_run_id,conversation_id,status,spec_json,etag,request_key,created_at)
       VALUES(?,?,?,'draft',?,?,?,?)`
    ).run(id, parentRunId, conversationId, JSON.stringify(normalized), hash, requestKey, Date.now())
    return planView(db.prepare('SELECT * FROM cluster_plans WHERE id=?').get(id))
  })
}

function getPlan(db, planId) {
  return planView(db.prepare('SELECT * FROM cluster_plans WHERE id=?').get(planId))
}

function listPlans(db, parentRunId) {
  return db
    .prepare('SELECT * FROM cluster_plans WHERE parent_run_id=? ORDER BY created_at DESC LIMIT 20')
    .all(parentRunId)
    .map(planView)
}

function confirmPlan(db, { planId, etag, assertParent = () => {}, commit }) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM cluster_plans WHERE id=?').get(planId)
    if (!row) throw remoteError('NOT_FOUND', '计划不存在', 404)
    if (row.status !== 'draft') {
      if (row.status === 'confirmed' && row.etag === etag) return planView(row)
      throw remoteError('STATE_CONFLICT', '计划已处理', 409)
    }
    if (row.etag !== etag) throw remoteError('PLAN_CONFLICT', '计划内容已变化', 409)
    assertParent()
    const result = commit(JSON.parse(row.spec_json))
    db.prepare(
      "UPDATE cluster_plans SET status='confirmed',confirmed_at=?,graph_id=? WHERE id=?"
    ).run(Date.now(), result.graphId, planId)
    return { ...planView(db.prepare('SELECT * FROM cluster_plans WHERE id=?').get(planId)), result }
  })
}

function rejectPlan(db, { planId, etag }) {
  return transaction(db, () => {
    const row = db.prepare('SELECT * FROM cluster_plans WHERE id=?').get(planId)
    if (!row) throw remoteError('NOT_FOUND', '计划不存在', 404)
    if (row.status !== 'draft') throw remoteError('STATE_CONFLICT', '计划已处理', 409)
    if (row.etag !== etag) throw remoteError('PLAN_CONFLICT', '计划内容已变化', 409)
    db.prepare("UPDATE cluster_plans SET status='rejected' WHERE id=?").run(planId)
    return getPlan(db, planId)
  })
}

module.exports = { createDraft, getPlan, listPlans, confirmPlan, rejectPlan, planView }
