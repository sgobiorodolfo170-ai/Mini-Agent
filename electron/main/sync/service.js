const crypto = require('node:crypto')
const { ROLES, remoteError, transaction } = require('../remote/protocol')

const ENTITY_COLUMNS = Object.freeze({
  projects: Object.freeze([
    'id',
    'name',
    'pinned',
    'sort',
    'created_at',
    'updated_at',
    'deleted_at'
  ]),
  conversations: Object.freeze([
    'id',
    'title',
    'pinned',
    'provider_id',
    'model',
    'system_prompt',
    'context_policy',
    'project_id',
    'permission',
    'origin',
    'parent_id',
    'created_by_run',
    'created_at',
    'updated_at',
    'deleted_at'
  ]),
  messages: Object.freeze([
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
  ])
})

const REQUIRED_COLUMNS = Object.freeze({
  projects: Object.freeze(['name', 'path', 'created_at', 'updated_at']),
  conversations: Object.freeze(['title', 'created_at', 'updated_at']),
  messages: Object.freeze(['conversation_id', 'role', 'seq', 'created_at', 'updated_at'])
})

const DEFAULT_LEASE_MS = 30000
const MAX_LEASE_MS = 86400000
const MAX_PULL_LIMIT = 1000
const MAX_PUSH_BATCH = 1000

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function parsePayload(value) {
  if (value === null || value === undefined) return null
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function readSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key)
  return row ? parsePayload(row.value) : undefined
}

function localDeviceId(db) {
  const value = readSetting(db, 'syncDeviceId')
  return typeof value === 'string' && value ? value : 'local'
}

function requireAuth(auth) {
  if (
    !auth ||
    typeof auth.deviceId !== 'string' ||
    !auth.deviceId.trim() ||
    !Array.isArray(ROLES[auth.role])
  ) {
    throw remoteError('UNAUTHENTICATED', '同步请求未认证', 401)
  }
}

function requireEnabled(db) {
  if (readSetting(db, 'syncEnabled') !== true) {
    throw remoteError('SYNC_DISABLED', '设备数据同步已停用', 403)
  }
}

function requireOperate(auth) {
  requireAuth(auth)
  if (!ROLES[auth.role].includes('operate')) {
    throw remoteError('FORBIDDEN', '当前设备没有同步操作权限', 403)
  }
}

function requireText(value, label, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw remoteError('INVALID_SYNC_CHANGE', `${label}无效`)
  }
  return value
}

function nullableVersion(value) {
  return value === null || value === undefined ? null : value
}

function requireVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw remoteError('INVALID_SYNC_CHANGE', `${label}无效`)
  }
  return value
}

function validatePayload(entity, entityId, payload) {
  if (!isPlainObject(payload)) {
    throw remoteError('INVALID_SYNC_CHANGE', 'payload 必须是对象')
  }
  const allowed = ENTITY_COLUMNS[entity]
  for (const column of Object.keys(payload)) {
    if (!allowed.includes(column)) {
      throw remoteError('INVALID_SYNC_CHANGE', `payload 列 ${column} 不在白名单内`)
    }
    const value = payload[column]
    if (value === null) continue
    if (
      !['string', 'number'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      throw remoteError('INVALID_SYNC_CHANGE', `payload 列 ${column} 类型无效`)
    }
  }
  if (payload.id !== entityId) {
    throw remoteError('INVALID_SYNC_CHANGE', 'payload.id 与 entityId 不一致')
  }
  for (const column of ['created_at', 'updated_at', 'deleted_at']) {
    if (payload[column] !== undefined && payload[column] !== null) {
      requireVersion(payload[column], `payload.${column}`)
    }
  }
  return payload
}

function validateRequiredRow(entity, row) {
  for (const column of REQUIRED_COLUMNS[entity]) {
    if (row[column] === undefined || row[column] === null) {
      throw remoteError('INVALID_SYNC_CHANGE', `payload 缺少必填列 ${column}`)
    }
  }
}

function normalizeChange(raw) {
  if (!isPlainObject(raw)) {
    throw remoteError('INVALID_SYNC_CHANGE', '同步变更必须是对象')
  }
  const changeId = requireText(raw.changeId, 'changeId')
  const deviceId = requireText(raw.deviceId, 'deviceId')
  const entity = requireText(raw.entity, 'entity', 32)
  if (!Object.hasOwn(ENTITY_COLUMNS, entity)) {
    throw remoteError('INVALID_SYNC_CHANGE', 'entity 不在白名单内')
  }
  const entityId = requireText(raw.entityId, 'entityId')
  if (raw.id !== undefined && raw.id !== entityId) {
    throw remoteError('INVALID_SYNC_CHANGE', 'id 与 entityId 不一致')
  }
  if (!['insert', 'update', 'delete'].includes(raw.op)) {
    throw remoteError('INVALID_SYNC_CHANGE', 'op 无效')
  }
  const payload = validatePayload(entity, entityId, raw.payload)
  const baseVersion = nullableVersion(raw.baseVersion)
  const newVersion = nullableVersion(raw.newVersion)

  if (raw.op === 'insert') {
    if (baseVersion !== null)
      throw remoteError('INVALID_SYNC_CHANGE', 'insert 的 baseVersion 必须为空')
    requireVersion(newVersion, 'newVersion')
    validateRequiredRow(entity, payload)
  } else if (raw.op === 'update') {
    requireVersion(baseVersion, 'baseVersion')
    requireVersion(newVersion, 'newVersion')
    if (newVersion < baseVersion) {
      throw remoteError('INVALID_SYNC_CHANGE', 'newVersion 不能小于 baseVersion')
    }
  } else {
    requireVersion(baseVersion, 'baseVersion')
    if (newVersion !== null) {
      throw remoteError('INVALID_SYNC_CHANGE', 'delete 的 newVersion 必须为空')
    }
  }

  if (
    newVersion !== null &&
    payload.updated_at !== undefined &&
    payload.updated_at !== newVersion
  ) {
    throw remoteError('INVALID_SYNC_CHANGE', 'payload.updated_at 与 newVersion 不一致')
  }
  if (
    raw.op === 'delete' &&
    payload.updated_at !== undefined &&
    payload.updated_at !== baseVersion
  ) {
    throw remoteError('INVALID_SYNC_CHANGE', 'payload.updated_at 与 baseVersion 不一致')
  }

  const leaseEpoch =
    raw.leaseEpoch === undefined || raw.leaseEpoch === null
      ? null
      : requireVersion(raw.leaseEpoch, 'leaseEpoch')
  return {
    changeId,
    deviceId,
    entity,
    entityId,
    op: raw.op,
    payload,
    baseVersion,
    newVersion,
    leaseEpoch
  }
}

function sanitizePayload(entity, payload) {
  if (!isPlainObject(payload)) return payload
  return Object.fromEntries(
    ENTITY_COLUMNS[entity]
      .filter((column) => Object.hasOwn(payload, column))
      .map((column) => [column, payload[column]])
  )
}

function mapChange(row) {
  return {
    seq: row.seq,
    changeId: row.change_id,
    deviceId: row.device_id,
    entity: row.entity,
    entityId: row.entity_id,
    op: row.op,
    payload: sanitizePayload(row.entity, parsePayload(row.payload)),
    baseVersion: row.base_version,
    newVersion: row.new_version,
    createdAt: row.created_at
  }
}

function mapConflict(row) {
  return {
    id: row.id,
    changeId: row.change_id,
    sourceDeviceId: row.source_device_id,
    entity: row.entity,
    entityId: row.entity_id,
    localPayload: sanitizePayload(row.entity, parsePayload(row.local_payload)),
    remotePayload: sanitizePayload(row.entity, parsePayload(row.remote_payload)),
    op: row.op,
    baseVersion: row.base_version,
    newVersion: row.new_version,
    leaseEpoch: row.lease_epoch,
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at
  }
}

function withSyncApplying(db, changeId, write) {
  const previous = db.prepare("SELECT value FROM settings WHERE key='syncApplying'").get()
  db.prepare(
    "INSERT INTO settings(key,value) VALUES('syncApplying',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value"
  ).run(JSON.stringify(`sync:${changeId}`))
  try {
    return write()
  } finally {
    if (previous) {
      db.prepare("UPDATE settings SET value=? WHERE key='syncApplying'").run(previous.value)
    } else {
      db.prepare("DELETE FROM settings WHERE key='syncApplying'").run()
    }
  }
}

function recordApplied(db, change, at) {
  db.prepare(
    `INSERT INTO sync_applied(change_id,source_device_id,applied_at) VALUES(?,?,?)
     ON CONFLICT(change_id) DO NOTHING`
  ).run(change.changeId, change.deviceId, at)
}

function saveConflict(db, change, local, reason, at) {
  const existing = db
    .prepare("SELECT * FROM sync_conflicts WHERE change_id=? AND status='open' LIMIT 1")
    .get(change.changeId)
  if (existing) return { ...mapConflict(existing), reason }
  const id = crypto.randomUUID()
  db.prepare(
    `INSERT INTO sync_conflicts(id,change_id,source_device_id,entity,entity_id,local_payload,
     remote_payload,op,base_version,new_version,lease_epoch,status,created_at,resolved_at)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,'open',?,NULL)`
  ).run(
    id,
    change.changeId,
    change.deviceId,
    change.entity,
    change.entityId,
    local ? JSON.stringify(local) : null,
    JSON.stringify(change.payload),
    change.op,
    change.baseVersion,
    change.newVersion,
    change.leaseEpoch ?? null,
    at
  )
  return {
    ...mapConflict(db.prepare('SELECT * FROM sync_conflicts WHERE id=?').get(id)),
    reason
  }
}

function createSyncService({ db, authService, now = Date.now }) {
  if (!db || !authService || typeof authService.requireGrant !== 'function') {
    throw new TypeError('createSyncService requires db and authService')
  }

  function requireLease(conversationId, auth, at = now(), epoch = null) {
    const lease = db
      .prepare('SELECT * FROM sync_leases WHERE conversation_id=?')
      .get(conversationId)
    if (
      !lease ||
      lease.owner_device_id !== auth.deviceId ||
      lease.expires_at <= at ||
      (epoch !== null && lease.epoch !== epoch)
    ) {
      throw remoteError('SYNC_LEASE_REQUIRED', '会话写租约无效或已过期', 409)
    }
    return lease
  }

  function messageConversation(change) {
    const payloadId = change.payload.conversation_id
    if (payloadId !== undefined && payloadId !== null) {
      requireText(payloadId, 'payload.conversation_id')
    }
    let currentId = null
    if (change.op !== 'insert') {
      const current = db
        .prepare('SELECT conversation_id FROM messages WHERE id=?')
        .get(change.entityId)
      currentId = current ? current.conversation_id : null
    }
    return {
      currentId,
      targetId: change.op === 'delete' && currentId ? currentId : (payloadId ?? currentId)
    }
  }

  function authorizeConversationWrite(auth, conversationId, at = now(), epoch = null) {
    authService.requireGrant(auth, conversationId, 'operate')
    if (epoch === null) throw remoteError('SYNC_LEASE_REQUIRED', '会话写租约 epoch 缺失', 409)
    requireLease(conversationId, auth, at, epoch)
  }

  function authorizeChange(auth, change) {
    if (change.deviceId !== auth.deviceId) {
      throw remoteError('FORBIDDEN', '不能以其他设备身份推送同步变更', 403)
    }
    if (change.entity === 'projects') {
      requireOperate(auth)
      if (change.op !== 'update') {
        throw remoteError(
          'INVALID_SYNC_CHANGE',
          '远端只能同步项目元数据，不能创建或删除本地项目',
          400
        )
      }
      return
    }
    const at = now()
    if (change.entity === 'conversations') {
      if (change.op === 'insert') {
        requireOperate(auth)
      } else {
        authorizeConversationWrite(auth, change.entityId, at, change.leaseEpoch)
      }
      return
    }
    const conversation = messageConversation(change)
    if (!conversation.targetId) {
      throw remoteError('INVALID_SYNC_CHANGE', '消息变更缺少 conversation_id')
    }
    authorizeConversationWrite(auth, conversation.targetId, at, change.leaseEpoch)
    if (
      change.op === 'update' &&
      conversation.currentId &&
      conversation.currentId !== conversation.targetId
    ) {
      authorizeConversationWrite(auth, conversation.currentId, at, change.leaseEpoch)
    }
  }

  function applyChange(change) {
    return transaction(db, () => {
      const applied = db
        .prepare('SELECT * FROM sync_applied WHERE change_id=?')
        .get(change.changeId)
      if (applied) {
        if (applied.source_device_id !== change.deviceId) {
          throw remoteError('IDEMPOTENCY_CONFLICT', 'change_id 已属于其他设备', 409)
        }
        return { applied: { changeId: change.changeId, idempotent: true } }
      }

      const at = now()
      const local = db.prepare(`SELECT * FROM ${change.entity} WHERE id=?`).get(change.entityId)
      let reason = null
      if (change.op === 'insert' && local) reason = 'row_exists'
      if (
        change.entity === 'messages' &&
        change.op === 'insert' &&
        change.payload.deleted_at == null &&
        db
          .prepare(
            'SELECT 1 FROM messages WHERE conversation_id=? AND seq=? AND deleted_at IS NULL'
          )
          .get(change.payload.conversation_id, change.payload.seq)
      ) {
        reason = 'sequence_exists'
      }
      if (change.op !== 'insert' && !local) reason = 'row_missing'
      if (change.op !== 'insert' && local && local.updated_at !== change.baseVersion) {
        reason = 'version_mismatch'
      }
      if (reason) return { conflict: saveConflict(db, change, local, reason, at) }

      if (change.op === 'update') {
        validateRequiredRow(change.entity, {
          ...local,
          ...change.payload,
          updated_at: change.newVersion
        })
      }

      withSyncApplying(db, change.changeId, () => {
        if (change.op === 'insert') {
          const columns = Object.keys(change.payload)
          const placeholders = columns.map(() => '?').join(',')
          db.prepare(
            `INSERT INTO ${change.entity} (${columns.join(',')}) VALUES (${placeholders})`
          ).run(...columns.map((column) => change.payload[column]))
        } else if (change.op === 'update') {
          const values = { ...change.payload, updated_at: change.newVersion }
          const columns = Object.keys(values).filter((column) => column !== 'id')
          db.prepare(
            `UPDATE ${change.entity} SET ${columns.map((column) => `${column}=?`).join(',')} WHERE id=?`
          ).run(...columns.map((column) => values[column]), change.entityId)
        } else {
          db.prepare(`DELETE FROM ${change.entity} WHERE id=?`).run(change.entityId)
        }
        recordApplied(db, change, at)
      })

      return {
        applied: {
          changeId: change.changeId,
          entity: change.entity,
          entityId: change.entityId,
          idempotent: false
        }
      }
    })
  }

  function status(auth) {
    requireAuth(auth)
    const deviceId = localDeviceId(db)
    const pending = db
      .prepare('SELECT COUNT(*) AS count FROM sync_changes WHERE device_id=?')
      .get(deviceId).count
    const conflicts = db
      .prepare("SELECT COUNT(*) AS count FROM sync_conflicts WHERE status='open'")
      .get().count
    const lastSeq = db.prepare('SELECT COALESCE(MAX(seq),0) AS seq FROM sync_changes').get().seq
    return {
      enabled: readSetting(db, 'syncEnabled') === true,
      deviceId,
      pending,
      conflicts,
      lastSeq
    }
  }

  function pull(auth, { after = 0, limit = 100 } = {}) {
    requireAuth(auth)
    requireEnabled(db)
    if (!Number.isSafeInteger(after) || after < 0) {
      throw remoteError('INVALID_SYNC_REQUEST', 'after 无效')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PULL_LIMIT) {
      throw remoteError('INVALID_SYNC_REQUEST', 'limit 无效')
    }
    return transaction(db, () => {
      const rows = db
        .prepare('SELECT * FROM sync_changes WHERE seq>? ORDER BY seq LIMIT ?')
        .all(after, limit + 1)
      const hasMs = rows.length > limit
      const page = hasMs ? rows.slice(0, limit) : rows
      const nextCursor = page.length ? page[page.length - 1].seq : after
      db.prepare(
        `INSERT INTO sync_cursors(device_id,peer_device_id,cursor,updated_at) VALUES(?,?,?,?)
         ON CONFLICT(device_id,peer_device_id) DO UPDATE SET
         cursor=MAX(sync_cursors.cursor,excluded.cursor),updated_at=excluded.updated_at`
      ).run(localDeviceId(db), auth.deviceId, nextCursor, now())
      return { changes: page.map(mapChange), nextCursor, hasMs }
    })
  }

  function acquireLease(auth, { conversationId, ttlMs = DEFAULT_LEASE_MS } = {}) {
    requireAuth(auth)
    requireEnabled(db)
    requireText(conversationId, 'conversationId')
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_LEASE_MS) {
      throw remoteError('INVALID_SYNC_REQUEST', 'ttlMs 无效')
    }
    return transaction(db, () => {
      authService.requireGrant(auth, conversationId, 'operate')
      const at = now()
      const current = db
        .prepare('SELECT * FROM sync_leases WHERE conversation_id=?')
        .get(conversationId)
      if (current && current.expires_at > at) {
        if (current.owner_device_id !== auth.deviceId) {
          throw Object.assign(remoteError('SYNC_LEASE_HELD', '会话写租约被其他设备持有', 409), {
            ownerDeviceId: current.owner_device_id,
            epoch: current.epoch,
            expiresAt: current.expires_at
          })
        }
        const expiresAt = Math.max(current.expires_at, at + ttlMs)
        db.prepare('UPDATE sync_leases SET expires_at=? WHERE conversation_id=?').run(
          expiresAt,
          conversationId
        )
        return {
          ownerDeviceId: current.owner_device_id,
          epoch: current.epoch,
          expiresAt
        }
      }
      const epoch = current ? current.epoch + 1 : 1
      const expiresAt = at + ttlMs
      db.prepare(
        `INSERT INTO sync_leases(conversation_id,owner_device_id,epoch,expires_at) VALUES(?,?,?,?)
         ON CONFLICT(conversation_id) DO UPDATE SET owner_device_id=excluded.owner_device_id,
         epoch=excluded.epoch,expires_at=excluded.expires_at`
      ).run(conversationId, auth.deviceId, epoch, expiresAt)
      return { ownerDeviceId: auth.deviceId, epoch, expiresAt }
    })
  }

  function push(auth, { changes } = {}) {
    requireAuth(auth)
    requireEnabled(db)
    if (!Array.isArray(changes) || changes.length > MAX_PUSH_BATCH) {
      throw remoteError('INVALID_SYNC_REQUEST', 'changes 必须是同步变更数组')
    }
    const result = { applied: [], conflicts: [], rejected: [] }
    for (const raw of changes) {
      try {
        const change = normalizeChange(raw)
        const previous = db
          .prepare('SELECT source_device_id FROM sync_applied WHERE change_id=?')
          .get(change.changeId)
        if (previous) {
          if (previous.source_device_id !== change.deviceId) {
            throw remoteError('IDEMPOTENCY_CONFLICT', 'change_id 已属于其他设备', 409)
          }
          result.applied.push({ changeId: change.changeId, idempotent: true })
          continue
        }
        authorizeChange(auth, change)
        const outcome = applyChange(change)
        if (outcome.conflict) result.conflicts.push(outcome.conflict)
        else result.applied.push(outcome.applied)
      } catch (error) {
        result.rejected.push({
          changeId: isPlainObject(raw) && typeof raw.changeId === 'string' ? raw.changeId : null,
          code: error.code || 'SYNC_APPLY_FAILED',
          error: error.message || '同步变更应用失败'
        })
      }
    }
    return result
  }

  function listConflicts(auth) {
    requireAuth(auth)
    requireEnabled(db)
    return db
      .prepare("SELECT * FROM sync_conflicts WHERE status='open' ORDER BY created_at DESC,id DESC")
      .all()
      .map(mapConflict)
  }

  function resolveConflict(auth, { id, resolution } = {}) {
    requireAuth(auth)
    requireEnabled(db)
    requireText(id, 'id', 200)
    if (!['local', 'remote'].includes(resolution)) {
      throw remoteError('INVALID_SYNC_REQUEST', 'resolution 必须是 local 或 remote')
    }
    const initial = db.prepare('SELECT * FROM sync_conflicts WHERE id=?').get(id)
    if (!initial) throw remoteError('NOT_FOUND', '同步冲突不存在', 404)

    let remotePayload = null
    if (resolution === 'remote') {
      if (!Object.hasOwn(ENTITY_COLUMNS, initial.entity)) {
        throw remoteError('INVALID_SYNC_CHANGE', '冲突 entity 不在白名单内')
      }
      remotePayload = validatePayload(
        initial.entity,
        initial.entity_id,
        sanitizePayload(initial.entity, parsePayload(initial.remote_payload))
      )
    }
    const localPayload = sanitizePayload(initial.entity, parsePayload(initial.local_payload))
    const selectedPayload = resolution === 'remote' ? remotePayload : localPayload
    function authorizeResolution() {
      if (initial.entity === 'projects') {
        requireOperate(auth)
        return
      }
      let conversationId = initial.entity_id
      if (initial.entity === 'messages') {
        conversationId =
          selectedPayload?.conversation_id ??
          localPayload?.conversation_id ??
          parsePayload(initial.remote_payload)?.conversation_id
      }
      if (!conversationId) {
        throw remoteError('INVALID_SYNC_CHANGE', '冲突消息缺少 conversation_id')
      }
      authService.requireGrant(auth, conversationId, 'operate')
      if (resolution === 'remote') {
        if (initial.lease_epoch === null) {
          throw remoteError('SYNC_LEASE_REQUIRED', '冲突缺少写租约 epoch', 409)
        }
        requireLease(conversationId, auth, now(), initial.lease_epoch)
      }
    }
    authorizeResolution()

    return transaction(db, () => {
      const conflict = db.prepare('SELECT * FROM sync_conflicts WHERE id=?').get(id)
      if (!conflict) throw remoteError('NOT_FOUND', '同步冲突不存在', 404)
      if (conflict.status !== 'open') {
        if (conflict.status === `resolved_${resolution}`) {
          return { ...mapConflict(conflict), resolution, idempotent: true }
        }
        throw remoteError('STATE_CONFLICT', '同步冲突已按其他方式解决', 409)
      }

      authorizeResolution()
      const at = now()
      const change = {
        changeId: conflict.change_id,
        deviceId: conflict.source_device_id,
        entity: conflict.entity,
        entityId: conflict.entity_id,
        op: conflict.op,
        leaseEpoch: conflict.lease_epoch,
        payload: selectedPayload
      }
      if (resolution === 'local') {
        recordApplied(db, change, at)
      } else {
        const current = db
          .prepare(`SELECT * FROM ${conflict.entity} WHERE id=?`)
          .get(conflict.entity_id)
        if (conflict.op !== 'delete') {
          validateRequiredRow(conflict.entity, { ...current, ...remotePayload })
        }
        withSyncApplying(db, conflict.change_id, () => {
          if (conflict.op === 'delete') {
            db.prepare(`DELETE FROM ${conflict.entity} WHERE id=?`).run(conflict.entity_id)
          } else {
            const columns = Object.keys(remotePayload)
            const values = { ...remotePayload, updated_at: conflict.new_version }
            const versionedUpdates = Object.keys(values).filter((column) => column !== 'id')
            if (current && versionedUpdates.length) {
              db.prepare(
                `UPDATE ${conflict.entity} SET ${versionedUpdates.map((column) => `${column}=?`).join(',')} WHERE id=?`
              ).run(...versionedUpdates.map((column) => values[column]), conflict.entity_id)
            } else if (!current) {
              const placeholders = columns.map(() => '?').join(',')
              db.prepare(
                `INSERT INTO ${conflict.entity} (${columns.join(',')}) VALUES (${placeholders})`
              ).run(...columns.map((column) => remotePayload[column]))
            }
          }
          recordApplied(db, change, at)
        })
      }
      db.prepare('UPDATE sync_conflicts SET status=?,resolved_at=? WHERE id=?').run(
        `resolved_${resolution}`,
        at,
        id
      )
      return {
        ...mapConflict(db.prepare('SELECT * FROM sync_conflicts WHERE id=?').get(id)),
        resolution,
        idempotent: false
      }
    })
  }

  return { status, pull, acquireLease, push, listConflicts, resolveConflict }
}

module.exports = { createSyncService }
