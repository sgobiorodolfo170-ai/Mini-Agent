const crypto = require('node:crypto')
const { z } = require('zod')

const ROLES = Object.freeze({ viewer: ['view'], operator: ['view', 'operate'], approver: ['view', 'approve'] })
const COMMANDS = [
  'session.subscribe', 'conversation.create', 'chat.message.send', 'chat.message.stop',
  'agent.run.start', 'agent.run.pause', 'agent.run.resume', 'agent.run.stop',
  'approval.respond', 'events.ack', 'device.heartbeat'
]
const envelopeSchema = z.object({
  v: z.literal(1), id: z.string().min(1).max(100), kind: z.literal('command'),
  type: z.enum(COMMANDS), conversation_id: z.string().max(100).nullish(),
  request_id: z.string().min(8).max(100), expected_version: z.number().int().positive().optional(),
  payload: z.record(z.string(), z.unknown()).default({}), sent_at: z.number().optional()
}).strict()

function parseEnvelope(value) {
  const result = envelopeSchema.safeParse(value)
  if (!result.success) throw remoteError('INVALID_MESSAGE', '消息格式不正确')
  return result.data
}
function remoteError(code, message, status = 400, retryable = false) {
  return Object.assign(new Error(message), { code, status, retryable })
}
function randomToken() { return crypto.randomBytes(32).toString('base64url') }
function tokenHash(token, domain = 'remote') {
  return crypto.createHash('sha256').update(`miniagent:${domain}:`).update(String(token || '')).digest('hex')
}
function secretEqual(a, b) {
  const left = Buffer.from(String(a || ''))
  const right = Buffer.from(String(b || ''))
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}
function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try { const out = fn(); db.exec('COMMIT'); return out } catch (e) { db.exec('ROLLBACK'); throw e }
}
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}
function cleanText(value, max = 100) { return String(value == null ? '' : value).trim().slice(0, max) }
function audit(db, { deviceId = null, actor = 'desktop', action, targetType = null, targetId = null, requestId = null, result = 'ok', detail = null }) {
  db.prepare(`INSERT INTO remote_audit_logs(device_id,actor,action,target_type,target_id,request_id,result,detail_json,created_at)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(deviceId, actor, action, targetType, targetId, requestId, result,
    detail ? JSON.stringify(detail).slice(0, 2000) : null, Date.now())
}
module.exports = { ROLES, COMMANDS, parseEnvelope, remoteError, randomToken, tokenHash, secretEqual, transaction, canonicalJson, cleanText, audit }
