import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dbm = require('../../electron/store/db')
const repos = require('../../electron/store/repos')
const { RemoteAuthService } = require('../../electron/main/remote/auth-service')
const { createSyncService } = require('../../electron/main/sync/service')

let db
let service
let clock
let auth
let otherAuth
let viewer

function expectCode(fn, code) {
  try {
    fn()
  } catch (error) {
    expect(error.code).toBe(code)
    return
  }
  throw new Error(`expected error ${code}`)
}

function insertProject(id, updatedAt = 10) {
  db.prepare(`INSERT INTO projects(id,name,path,created_at,updated_at) VALUES(?,?,?,?,?)`).run(
    id,
    `项目-${id}`,
    `C:\\${id}`,
    1,
    updatedAt
  )
}

function projectChange(overrides = {}) {
  return {
    changeId: 'change-project-1',
    deviceId: auth.deviceId,
    entity: 'projects',
    entityId: 'p1',
    op: 'update',
    baseVersion: 10,
    newVersion: 20,
    payload: { id: 'p1', updated_at: 20 },
    ...overrides
  }
}

function outbox() {
  return db.prepare('SELECT * FROM sync_changes ORDER BY seq').all()
}

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
  db = dbm.get()
  repos.setSetting(db, 'syncDeviceId', 'local-device')
  repos.setSetting(db, 'syncEnabled', true)
  db.prepare('DELETE FROM sync_changes').run()
  clock = 1000
  service = createSyncService({
    db,
    authService: new RemoteAuthService({ db }),
    now: () => clock
  })
  auth = { deviceId: 'device-a', role: 'operator' }
  otherAuth = { deviceId: 'device-b', role: 'operator' }
  viewer = { deviceId: 'viewer-a', role: 'viewer' }
})

afterEach(() => {
  dbm.close()
})

describe('同步 outbox 与拉取', () => {
  it('记录 projects insert/update/delete，payload 与版本正确', () => {
    insertProject('p-outbox', 10)
    db.prepare("UPDATE projects SET name='改名',updated_at=20 WHERE id='p-outbox'").run()
    db.prepare("DELETE FROM projects WHERE id='p-outbox'").run()

    const rows = outbox()
    expect(rows.map((row) => row.op)).toEqual(['insert', 'update', 'delete'])
    expect(rows.map((row) => row.entity_id)).toEqual(['p-outbox', 'p-outbox', 'p-outbox'])
    expect(rows[0]).toMatchObject({ base_version: null, new_version: 10 })
    expect(rows[1]).toMatchObject({ base_version: 10, new_version: 20 })
    expect(rows[2]).toMatchObject({ base_version: 20, new_version: null })
    expect(JSON.parse(rows[0].payload)).toMatchObject({ id: 'p-outbox', name: '项目-p-outbox' })
    expect(JSON.parse(rows[1].payload)).toMatchObject({ id: 'p-outbox', name: '改名' })
    expect(JSON.parse(rows[2].payload)).toMatchObject({ id: 'p-outbox', name: '改名' })
  })

  it('allows operators to create a conversation before acquiring its write lease', () => {
    const result = service.push(auth, {
      changes: [
        {
          changeId: 'conversation-insert-1',
          deviceId: auth.deviceId,
          entity: 'conversations',
          entityId: 'new-conversation',
          op: 'insert',
          baseVersion: null,
          newVersion: 10,
          payload: {
            id: 'new-conversation',
            title: '新同步会话',
            created_at: 1,
            updated_at: 10
          }
        }
      ]
    })
    expect(result.rejected).toEqual([])
    expect(result.applied).toHaveLength(1)
  })

  it('strips project path and verification commands from sync payloads', () => {
    insertProject('safe-project', 10)
    const pulled = service.pull(auth, { limit: 10 }).changes[0]
    expect(pulled.payload.path).toBeUndefined()
    expect(pulled.payload.workspace_verify_command).toBeUndefined()
    const result = service.push(auth, {
      changes: [projectChange({ payload: { id: 'p1', path: 'C:\\evil', updated_at: 20 } })]
    })
    expect(result.rejected[0].code).toBe('INVALID_SYNC_CHANGE')
    const create = service.push(auth, {
      changes: [
        projectChange({
          op: 'insert',
          baseVersion: null,
          newVersion: 20,
          payload: { id: 'p1', name: '远端项目', created_at: 1, updated_at: 20 }
        })
      ]
    })
    expect(create.rejected[0].code).toBe('INVALID_SYNC_CHANGE')
    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(1)
  })

  it('rejects duplicate active message sequence numbers as a conflict', () => {
    const conversation = repos.createConversation(db, { title: '消息序列' })
    const lease = service.acquireLease(auth, { conversationId: conversation.id, ttlMs: 5000 })
    const change = (changeId, entityId) => ({
      changeId,
      deviceId: auth.deviceId,
      entity: 'messages',
      entityId,
      op: 'insert',
      baseVersion: null,
      newVersion: 10,
      leaseEpoch: lease.epoch,
      payload: {
        id: entityId,
        conversation_id: conversation.id,
        role: 'user',
        content: changeId,
        seq: 1,
        created_at: 1,
        updated_at: 10
      }
    })
    expect(service.push(auth, { changes: [change('seq-1', 'm1')] }).applied).toHaveLength(1)
    const duplicate = service.push(auth, { changes: [change('seq-2', 'm2')] })
    expect(duplicate.conflicts[0].reason).toBe('sequence_exists')
  })

  it('停用同步后拒绝拉取和写入', () => {
    repos.setSetting(db, 'syncEnabled', false)
    expectCode(() => service.pull(auth, { limit: 10 }), 'SYNC_DISABLED')
    expectCode(() => service.push(auth, { changes: [] }), 'SYNC_DISABLED')
  })

  it('status 返回本地状态，pull 分页并单调更新游标', () => {
    insertProject('p1', 10)
    insertProject('p2', 20)
    insertProject('p3', 30)

    expect(service.status(auth)).toEqual({
      enabled: true,
      deviceId: 'local-device',
      pending: 3,
      conflicts: 0,
      lastSeq: 3
    })

    const first = service.pull(auth, { limit: 2 })
    expect(first.changes.map((change) => change.seq)).toEqual([1, 2])
    expect(first.changes[0]).toMatchObject({
      changeId: expect.any(String),
      deviceId: 'local-device',
      entity: 'projects',
      entityId: 'p1',
      op: 'insert',
      baseVersion: null,
      newVersion: 10,
      payload: { id: 'p1' }
    })
    expect(first.nextCursor).toBe(2)
    expect(first.hasMs).toBe(true)
    expect(db.prepare('SELECT * FROM sync_cursors').get()).toMatchObject({
      device_id: 'local-device',
      peer_device_id: 'device-a',
      cursor: 2
    })

    const second = service.pull(auth, { after: first.nextCursor, limit: 2 })
    expect(second.changes.map((change) => change.seq)).toEqual([3])
    expect(second.nextCursor).toBe(3)
    expect(second.hasMs).toBe(false)

    service.pull(auth, { after: 0, limit: 1 })
    expect(db.prepare('SELECT cursor FROM sync_cursors').get().cursor).toBe(3)
    expect(service.pull(auth, { after: 3 })).toEqual({
      changes: [],
      nextCursor: 3,
      hasMs: false
    })
  })
})

describe('同步写租约', () => {
  it('同一会话单写，同设备续租不增加 epoch，过期后可接管', () => {
    const conversation = repos.createConversation(db, { title: '租约会话' })
    const first = service.acquireLease(auth, { conversationId: conversation.id, ttlMs: 1000 })
    expect(first).toEqual({ ownerDeviceId: 'device-a', epoch: 1, expiresAt: 2000 })

    clock = 1500
    expect(service.acquireLease(auth, { conversationId: conversation.id, ttlMs: 500 })).toEqual({
      ownerDeviceId: 'device-a',
      epoch: 1,
      expiresAt: 2000
    })
    expectCode(
      () => service.acquireLease(otherAuth, { conversationId: conversation.id, ttlMs: 1000 }),
      'SYNC_LEASE_HELD'
    )

    clock = 2000
    expect(
      service.acquireLease(otherAuth, { conversationId: conversation.id, ttlMs: 1000 })
    ).toEqual({
      ownerDeviceId: 'device-b',
      epoch: 2,
      expiresAt: 3000
    })

    const current = db
      .prepare('SELECT updated_at FROM conversations WHERE id=?')
      .get(conversation.id)
    const stale = service.push(auth, {
      changes: [
        {
          changeId: 'stale-conversation',
          deviceId: auth.deviceId,
          entity: 'conversations',
          entityId: conversation.id,
          op: 'update',
          baseVersion: current.updated_at,
          newVersion: current.updated_at + 1,
          leaseEpoch: 1,
          payload: { id: conversation.id, title: '旧租约写入', updated_at: current.updated_at + 1 }
        }
      ]
    })
    expect(stale.applied).toEqual([])
    expect(stale.rejected[0].code).toBe('SYNC_LEASE_REQUIRED')
  })

  it('消息 delete 按实际所属会话校验租约，不接受 payload 伪造', () => {
    const ownerConversation = repos.createConversation(db, { title: '消息所属会话' })
    const otherConversation = repos.createConversation(db, { title: '伪造会话' })
    const message = repos.insertMessage(db, {
      conversationId: ownerConversation.id,
      role: 'user',
      content: '待删除'
    })
    const current = db.prepare('SELECT updated_at FROM messages WHERE id=?').get(message.id)
    service.acquireLease(auth, { conversationId: otherConversation.id, ttlMs: 5000 })
    const change = {
      changeId: 'message-delete-lease',
      deviceId: auth.deviceId,
      entity: 'messages',
      entityId: message.id,
      op: 'delete',
      baseVersion: current.updated_at,
      newVersion: null,
      leaseEpoch: 1,
      payload: {
        id: message.id,
        conversation_id: otherConversation.id,
        updated_at: current.updated_at
      }
    }

    expect(service.push(auth, { changes: [change] }).rejected[0].code).toBe('SYNC_LEASE_REQUIRED')
    expect(db.prepare('SELECT id FROM messages WHERE id=?').get(message.id)).toBeDefined()

    const ownerLease = service.acquireLease(auth, {
      conversationId: ownerConversation.id,
      ttlMs: 5000
    })
    change.leaseEpoch = ownerLease.epoch
    expect(service.push(auth, { changes: [change] }).applied).toHaveLength(1)
    expect(db.prepare('SELECT id FROM messages WHERE id=?').get(message.id)).toBeUndefined()
  })

  it('有效自有租约允许推送会话消息', () => {
    const conversation = repos.createConversation(db, { title: '消息租约' })
    service.acquireLease(auth, { conversationId: conversation.id, ttlMs: 5000 })
    const result = service.push(auth, {
      changes: [
        {
          changeId: 'message-insert-1',
          deviceId: auth.deviceId,
          entity: 'messages',
          entityId: 'm1',
          op: 'insert',
          baseVersion: null,
          newVersion: 10,
          leaseEpoch: 1,
          payload: {
            id: 'm1',
            conversation_id: conversation.id,
            role: 'user',
            content: '同步消息',
            seq: 1,
            created_at: 10,
            updated_at: 10
          }
        }
      ]
    })
    expect(result.rejected).toEqual([])
    expect(result.applied).toHaveLength(1)
    expect(db.prepare('SELECT content FROM messages WHERE id=?').get('m1').content).toBe('同步消息')
  })
})

describe('幂等、echo 抑制与冲突', () => {
  it('按 change_id 幂等，重复推送不重复写入', () => {
    insertProject('p1', 10)
    const change = projectChange()
    const first = service.push(auth, { changes: [change] })
    const second = service.push(auth, { changes: [change] })

    expect(first.applied).toHaveLength(1)
    expect(second.applied).toEqual([{ changeId: change.changeId, idempotent: true }])
    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get().count).toBe(1)
    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_applied').get().count).toBe(1)
  })

  it('应用远端变更时设置 syncApplying，不产生 echo outbox', () => {
    insertProject('p1', 10)
    expect(outbox()).toHaveLength(1)
    const result = service.push(auth, {
      changes: [projectChange({ payload: { id: 'p1', name: '远端改名', updated_at: 20 } })]
    })

    expect(result.applied).toHaveLength(1)
    expect(outbox()).toHaveLength(1)
    expect(db.prepare('SELECT name,updated_at FROM projects WHERE id=?').get('p1')).toEqual({
      name: '远端改名',
      updated_at: 20
    })
    expect(db.prepare("SELECT value FROM settings WHERE key='syncApplying'").get()).toBeUndefined()
    expect(db.prepare('SELECT change_id FROM sync_applied').get().change_id).toBe(
      'change-project-1'
    )
  })

  it('版本不匹配或行缺失时保存双方 payload 并返回 conflict', () => {
    insertProject('p1', 10)
    const result = service.push(auth, {
      changes: [
        projectChange({ baseVersion: 9 }),
        projectChange({
          changeId: 'missing-project',
          entityId: 'missing',
          baseVersion: 1,
          newVersion: 2,
          payload: { id: 'missing', updated_at: 2 }
        })
      ]
    })

    expect(result.applied).toEqual([])
    expect(result.conflicts.map((conflict) => conflict.reason)).toEqual([
      'version_mismatch',
      'row_missing'
    ])
    expect(result.conflicts[0]).toMatchObject({
      changeId: 'change-project-1',
      sourceDeviceId: 'device-a',
      entity: 'projects',
      entityId: 'p1',
      localPayload: { id: 'p1', updated_at: 10 },
      remotePayload: { id: 'p1', updated_at: 20 },
      status: 'open'
    })
    expect(result.conflicts[1].localPayload).toBeNull()
    expect(db.prepare('SELECT updated_at FROM projects WHERE id=?').get('p1').updated_at).toBe(10)
    expect(service.listConflicts(auth)).toHaveLength(2)
  })

  it('local 保留本地并把远端 change 标记为已忽略', () => {
    insertProject('p1', 10)
    const change = projectChange({
      baseVersion: 9,
      payload: { id: 'p1', name: '远端改名', updated_at: 20 }
    })
    const conflict = service.push(auth, { changes: [change] }).conflicts[0]

    const resolved = service.resolveConflict(auth, { id: conflict.id, resolution: 'local' })
    expect(resolved).toMatchObject({ status: 'resolved_local', resolution: 'local' })
    expect(db.prepare('SELECT name,updated_at FROM projects WHERE id=?').get('p1')).toEqual({
      name: '项目-p1',
      updated_at: 10
    })
    expect(db.prepare('SELECT change_id FROM sync_applied').get().change_id).toBe(change.changeId)
    expect(service.listConflicts(auth)).toEqual([])

    const retry = service.push(auth, { changes: [change] })
    expect(retry.conflicts).toEqual([])
    expect(retry.applied).toEqual([{ changeId: change.changeId, idempotent: true }])
  })

  it('remote 按保存的 payload 强制应用，仍需 operate 权限且不产生 echo', () => {
    insertProject('p1', 10)
    const change = projectChange({
      baseVersion: 9,
      payload: { id: 'p1', name: '远端强制改名', updated_at: 20 }
    })
    const conflict = service.push(auth, { changes: [change] }).conflicts[0]

    expectCode(
      () => service.resolveConflict(viewer, { id: conflict.id, resolution: 'remote' }),
      'FORBIDDEN'
    )
    expect(db.prepare('SELECT name FROM projects WHERE id=?').get('p1').name).toBe('项目-p1')

    const resolved = service.resolveConflict(auth, { id: conflict.id, resolution: 'remote' })
    expect(resolved).toMatchObject({ status: 'resolved_remote', resolution: 'remote' })
    expect(db.prepare('SELECT name,updated_at FROM projects WHERE id=?').get('p1')).toEqual({
      name: '远端强制改名',
      updated_at: 20
    })
    expect(outbox()).toHaveLength(1)
    expect(
      service.resolveConflict(auth, { id: conflict.id, resolution: 'remote' }).idempotent
    ).toBe(true)
  })

  it('会话冲突 remote 解决仍要求有效自有租约', () => {
    const conversation = repos.createConversation(db, { title: '本地标题' })
    const lease = service.acquireLease(auth, { conversationId: conversation.id, ttlMs: 5000 })
    const change = {
      changeId: 'conversation-conflict',
      deviceId: auth.deviceId,
      entity: 'conversations',
      entityId: conversation.id,
      op: 'update',
      baseVersion: conversation.updatedAt - 1,
      newVersion: conversation.updatedAt + 1,
      leaseEpoch: lease.epoch,
      payload: { id: conversation.id, title: '远端标题', updated_at: conversation.updatedAt + 1 }
    }
    const conflict = service.push(auth, { changes: [change] }).conflicts[0]

    expectCode(
      () => service.resolveConflict(otherAuth, { id: conflict.id, resolution: 'remote' }),
      'SYNC_LEASE_REQUIRED'
    )
    service.resolveConflict(auth, { id: conflict.id, resolution: 'remote' })
    expect(
      db.prepare('SELECT title FROM conversations WHERE id=?').get(conversation.id).title
    ).toBe('远端标题')
  })
})

describe('同步批量应用', () => {
  it('10k 条项目元数据变更分 10 批应用，最终版本与幂等记录完整', () => {
    insertProject('p-bulk', 0)
    const started = Date.now()
    for (let batch = 0; batch < 10; batch++) {
      const changes = Array.from({ length: 1000 }, (_, offset) => {
        const index = batch * 1000 + offset
        const baseVersion = index
        const newVersion = index + 1
        return {
          changeId: `bulk-apply-${index}`,
          deviceId: auth.deviceId,
          entity: 'projects',
          entityId: 'p-bulk',
          op: 'update',
          baseVersion,
          newVersion,
          payload: {
            id: 'p-bulk',
            name: `bulk-${index}`,
            updated_at: newVersion
          }
        }
      })
      const result = service.push(auth, { changes })
      expect(result.applied).toHaveLength(1000)
      expect(result.conflicts).toEqual([])
      expect(result.rejected).toEqual([])
    }
    expect(db.prepare('SELECT name,updated_at FROM projects WHERE id=?').get('p-bulk')).toEqual({
      name: 'bulk-9999',
      updated_at: 10000
    })
    expect(db.prepare('SELECT COUNT(*) AS count FROM sync_applied').get().count).toBe(10000)
    console.info(`SYNC_APPLY_10K elapsed_ms=${Date.now() - started}`)
  }, 30000)
})

describe('同步输入与授权边界', () => {
  it('拒绝未认证、viewer 写操作、伪造设备和非法实体/列', () => {
    const conversation = repos.createConversation(db, { title: '授权会话' })
    expectCode(() => service.status(null), 'UNAUTHENTICATED')
    expectCode(() => service.pull(null), 'UNAUTHENTICATED')
    expectCode(() => service.push(null, { changes: [] }), 'UNAUTHENTICATED')
    expectCode(() => service.listConflicts(null), 'UNAUTHENTICATED')
    expectCode(
      () => service.acquireLease(viewer, { conversationId: conversation.id, ttlMs: 1000 }),
      'FORBIDDEN'
    )

    const denied = service.push(viewer, { changes: [projectChange({ deviceId: viewer.deviceId })] })
    expect(denied.rejected[0].code).toBe('FORBIDDEN')

    const injected = service.push(auth, {
      changes: [
        projectChange({ entity: 'projects; DROP TABLE projects' }),
        projectChange({
          changeId: 'column-injection',
          payload: { id: 'p1', updated_at: 20, 'name); DROP TABLE projects;--': 'x' }
        }),
        projectChange({ changeId: 'wrong-device', deviceId: 'device-b' }),
        projectChange({ changeId: 'wrong-id', payload: { id: 'other', updated_at: 20 } }),
        projectChange({ changeId: 'wrong-version', newVersion: 9 })
      ]
    })
    expect(injected.rejected.map((item) => item.code)).toEqual([
      'INVALID_SYNC_CHANGE',
      'INVALID_SYNC_CHANGE',
      'FORBIDDEN',
      'INVALID_SYNC_CHANGE',
      'INVALID_SYNC_CHANGE'
    ])
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get()
    ).toEqual({ name: 'projects' })
  })
})
