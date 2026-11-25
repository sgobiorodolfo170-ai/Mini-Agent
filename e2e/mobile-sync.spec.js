/* global window, Event, URL, console */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { closeApp, launchApp } from './helpers'
import {
  closeMobileBrowser,
  createMobileContext,
  installMobileSocketControl,
  launchMobileBrowser,
  mobileApi,
  pairMobilePage
} from './mobile-helpers'

let ctx
let browser
let tempDirs

async function prepareSync() {
  const { win } = ctx
  const conversation = await win.evaluate(() =>
    window.api.conversations.create({ title: '双机同步会话' })
  )
  const remote = await win.evaluate(async () => {
    await window.api.settings.set('syncEnabled', true)
    const state = await window.api.remote.start({
      host: '127.0.0.1',
      port: 0,
      transport: 'tls'
    })
    return { state, qr: await window.api.remote.qrcode() }
  })
  return { conversation, remote }
}

async function pairDevice(device, socketControl = false) {
  const qr = await ctx.win.evaluate(() => window.api.remote.qrcode())
  const mobile = await createMobileContext(browser, device)
  if (socketControl) await installMobileSocketControl(mobile.context)
  await pairMobilePage(mobile.page, qr.url)
  const me = await mobileApi(mobile.page, '/devices/me')
  expect(me.status).toBe(200)
  return { ...mobile, deviceId: me.body.deviceId }
}

function messageChange({ changeId, deviceId, conversationId, seq, content, version, leaseEpoch }) {
  return {
    changeId,
    deviceId,
    entity: 'messages',
    entityId: `${changeId}-message`,
    op: 'insert',
    baseVersion: null,
    newVersion: version,
    leaseEpoch,
    payload: {
      id: `${changeId}-message`,
      conversation_id: conversationId,
      role: 'user',
      content,
      seq,
      created_at: version,
      updated_at: version
    }
  }
}

async function conversationVersion(conversationId) {
  return ctx.electronApp.evaluate((_electron, id) => {
    const db = globalThis.__miniagentRemoteEvents.authService.db
    return db.prepare('SELECT title,updated_at AS updatedAt FROM conversations WHERE id=?').get(id)
  }, conversationId)
}

beforeEach(async () => {
  tempDirs = []
  ctx = await launchApp()
  browser = await launchMobileBrowser()
})

afterEach(async () => {
  await closeMobileBrowser(browser)
  browser = null
  if (ctx) await closeApp(ctx.electronApp, ctx.mock)
  ctx = null
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('双设备同步验收', () => {
  it('两台设备完成拉取、租约接管、幂等、乱序、冲突解决与安全门禁', async () => {
    const { conversation, remote } = await prepareSync()
    const android = await pairDevice('android', true)
    const iphone = await pairDevice('iphone')

    expect(android.deviceId).not.toBe(iphone.deviceId)
    const statusA = await mobileApi(android.page, '/sync/status')
    const statusB = await mobileApi(iphone.page, '/sync/status')
    expect(statusA.status).toBe(200)
    expect(statusB.status).toBe(200)
    expect(statusA.body).toMatchObject({ enabled: true, deviceId: expect.any(String) })
    expect(statusB.body.deviceId).toBe(statusA.body.deviceId)

    const rogue = await createMobileContext(browser, 'android')
    await rogue.page.goto(new URL(remote.qr.url).origin, { waitUntil: 'domcontentloaded' })
    expect((await mobileApi(rogue.page, '/sync/status')).status).toBe(401)

    const missingCsrf = await mobileApi(iphone.page, '/sync/lease', {
      method: 'POST',
      body: { conversationId: conversation.id, ttlMs: 1000 },
      csrf: false
    })
    expect(missingCsrf.status).toBe(403)
    expect(missingCsrf.body.error.code).toBe('CSRF_INVALID')

    const seeded = await ctx.electronApp.evaluate((_electron, conversationId) => {
      const db = globalThis.__miniagentRemoteEvents.authService.db
      const id = 'dual-desktop-message'
      const now = Date.now()
      const seq = db
        .prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM messages WHERE conversation_id=?')
        .get(conversationId).seq
      db.prepare(
        `INSERT INTO messages(id,conversation_id,role,content,status,seq,created_at,updated_at)
         VALUES(?,?,'user',?,'done',?,?,?)`
      ).run(id, conversationId, '桌面权威变更', seq, now, now)
      return { id, seq }
    }, conversation.id)

    const pullA = await mobileApi(android.page, '/sync/changes?after=0&limit=1000')
    const pullB = await mobileApi(iphone.page, '/sync/changes?after=0&limit=1000')
    expect(pullA.status).toBe(200)
    expect(pullB.status).toBe(200)
    expect(pullA.body.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entity: 'messages',
          entityId: seeded.id,
          payload: expect.objectContaining({ content: '桌面权威变更' })
        })
      ])
    )
    expect(pullB.body.changes.map((change) => change.changeId)).toEqual(
      pullA.body.changes.map((change) => change.changeId)
    )

    const leaseA = await mobileApi(android.page, '/sync/lease', {
      method: 'POST',
      body: { conversationId: conversation.id, ttlMs: 500 }
    })
    expect(leaseA.status).toBe(200)
    expect(leaseA.body).toMatchObject({ ownerDeviceId: android.deviceId, epoch: 1 })
    const held = await mobileApi(iphone.page, '/sync/lease', {
      method: 'POST',
      body: { conversationId: conversation.id, ttlMs: 1000 }
    })
    expect(held.status).toBe(409)
    expect(held.body.error.code).toBe('SYNC_LEASE_HELD')

    const changeA = messageChange({
      changeId: 'dual-a-1',
      deviceId: android.deviceId,
      conversationId: conversation.id,
      seq: seeded.seq + 1,
      content: '设备 A 离线补发',
      version: 1000,
      leaseEpoch: leaseA.body.epoch
    })
    const pushA = await mobileApi(android.page, '/sync/push', {
      method: 'POST',
      body: { changes: [changeA] }
    })
    expect(pushA.status).toBe(200)
    expect(pushA.body.applied).toHaveLength(1)
    expect(pushA.body.rejected).toEqual([])
    const replayA = await mobileApi(android.page, '/sync/push', {
      method: 'POST',
      body: { changes: [changeA] }
    })
    expect(replayA.body.applied).toEqual([{ changeId: changeA.changeId, idempotent: true }])

    const messagesForB = await mobileApi(
      iphone.page,
      `/conversations/${conversation.id}/messages?limit=100`
    )
    expect(messagesForB.status).toBe(200)
    expect(
      messagesForB.body.filter((message) => message.content === '设备 A 离线补发')
    ).toHaveLength(1)

    await expect
      .poll(
        async () =>
          (
            await mobileApi(iphone.page, '/sync/lease', {
              method: 'POST',
              body: { conversationId: conversation.id, ttlMs: 500 }
            })
          ).status,
        { timeout: 5000 }
      )
      .toBe(200)
    const leaseB = await mobileApi(iphone.page, '/sync/lease', {
      method: 'POST',
      body: { conversationId: conversation.id, ttlMs: 500 }
    })
    expect(leaseB.body.epoch).toBe(2)

    const staleA = await mobileApi(android.page, '/sync/push', {
      method: 'POST',
      body: {
        changes: [
          messageChange({
            changeId: 'dual-a-stale',
            deviceId: android.deviceId,
            conversationId: conversation.id,
            seq: seeded.seq + 2,
            content: '旧租约必须拒绝',
            version: 1001,
            leaseEpoch: leaseA.body.epoch
          })
        ]
      }
    })
    expect(staleA.body.rejected[0].code).toBe('SYNC_LEASE_REQUIRED')

    const outOfOrder = [
      messageChange({
        changeId: 'dual-b-4',
        deviceId: iphone.deviceId,
        conversationId: conversation.id,
        seq: seeded.seq + 4,
        content: '设备 B 乱序消息 4',
        version: 1004,
        leaseEpoch: leaseB.body.epoch
      }),
      messageChange({
        changeId: 'dual-b-3',
        deviceId: iphone.deviceId,
        conversationId: conversation.id,
        seq: seeded.seq + 3,
        content: '设备 B 乱序消息 3',
        version: 1003,
        leaseEpoch: leaseB.body.epoch
      })
    ]
    const pushB = await mobileApi(iphone.page, '/sync/push', {
      method: 'POST',
      body: { changes: outOfOrder }
    })
    expect(pushB.body.applied).toHaveLength(2)
    expect(pushB.body.rejected).toEqual([])

    const leaseBRefresh = await mobileApi(iphone.page, '/sync/lease', {
      method: 'POST',
      body: { conversationId: conversation.id, ttlMs: 500 }
    })
    expect(leaseBRefresh.body.epoch).toBe(leaseB.body.epoch)
    const beforeConflict = await conversationVersion(conversation.id)
    const updateB = await mobileApi(iphone.page, '/sync/push', {
      method: 'POST',
      body: {
        changes: [
          {
            changeId: 'dual-b-title',
            deviceId: iphone.deviceId,
            entity: 'conversations',
            entityId: conversation.id,
            op: 'update',
            baseVersion: beforeConflict.updatedAt,
            newVersion: beforeConflict.updatedAt + 1,
            leaseEpoch: leaseBRefresh.body.epoch,
            payload: {
              id: conversation.id,
              title: '设备 B 的标题',
              updated_at: beforeConflict.updatedAt + 1
            }
          }
        ]
      }
    })
    expect(updateB.body.applied).toHaveLength(1)

    await expect
      .poll(
        async () =>
          (
            await mobileApi(android.page, '/sync/lease', {
              method: 'POST',
              body: { conversationId: conversation.id, ttlMs: 500 }
            })
          ).status,
        { timeout: 5000 }
      )
      .toBe(200)
    const leaseA2 = await mobileApi(android.page, '/sync/lease', {
      method: 'POST',
      body: { conversationId: conversation.id, ttlMs: 500 }
    })
    const conflictPush = await mobileApi(android.page, '/sync/push', {
      method: 'POST',
      body: {
        changes: [
          {
            changeId: 'dual-a-conflict-title',
            deviceId: android.deviceId,
            entity: 'conversations',
            entityId: conversation.id,
            op: 'update',
            baseVersion: beforeConflict.updatedAt,
            newVersion: beforeConflict.updatedAt + 2,
            leaseEpoch: leaseA2.body.epoch,
            payload: {
              id: conversation.id,
              title: '设备 A 的冲突标题',
              updated_at: beforeConflict.updatedAt + 2
            }
          }
        ]
      }
    })
    expect(conflictPush.body.conflicts).toHaveLength(1)
    const conflict = conflictPush.body.conflicts[0]
    expect(conflict).toMatchObject({
      reason: 'version_mismatch',
      status: 'open',
      localPayload: expect.objectContaining({ title: '设备 B 的标题' }),
      remotePayload: expect.objectContaining({ title: '设备 A 的冲突标题' })
    })
    const conflictsB = await mobileApi(iphone.page, '/sync/conflicts')
    expect(conflictsB.body).toEqual([expect.objectContaining({ id: conflict.id })])
    const resolved = await mobileApi(android.page, `/sync/conflicts/${conflict.id}/resolve`, {
      method: 'POST',
      body: { resolution: 'local' }
    })
    expect(resolved.body).toMatchObject({ status: 'resolved_local', resolution: 'local' })
    expect((await conversationVersion(conversation.id)).title).toBe('设备 B 的标题')
    expect(await mobileApi(iphone.page, '/sync/conflicts')).toEqual({ status: 200, body: [] })

    const rollbackA = await mobileApi(android.page, '/sync/changes?after=0&limit=1000')
    const rollbackB = await mobileApi(iphone.page, '/sync/changes?after=0&limit=1000')
    expect(rollbackA.body.nextCursor).toBeGreaterThanOrEqual(pullA.body.nextCursor)
    expect(rollbackB.body.nextCursor).toBeGreaterThanOrEqual(pullB.body.nextCursor)

    const reconnectStarted = Date.now()
    await android.page.evaluate(() => {
      window.__miniAgentSocketOffline = true
      for (const socket of window.__miniAgentSockets) socket.close(1000, 'sync acceptance')
    })
    await expect
      .poll(async () => (await android.page.getByTestId('remote-connection').textContent()) || '')
      .toMatch(/重连中|未连接/)
    await android.page.evaluate(() => {
      window.__miniAgentSocketOffline = false
      window.dispatchEvent(new Event('focus'))
    })
    await expect
      .poll(async () => (await android.page.getByTestId('remote-connection').textContent()) || '', {
        timeout: 10000
      })
      .toContain('已连接')
    console.info(`SYNC_WS_RECONNECT_MS=${Date.now() - reconnectStarted}`)

    await ctx.win.evaluate(() => window.api.settings.set('syncEnabled', false))
    const disabledStatus = await mobileApi(android.page, '/sync/status')
    expect(disabledStatus.status).toBe(200)
    expect(disabledStatus.body.enabled).toBe(false)
    const disabled = await mobileApi(android.page, '/sync/changes?after=0&limit=10')
    expect(disabled.status).toBe(403)
    expect(disabled.body.error.code).toBe('SYNC_DISABLED')
    const localStillWorks = await mobileApi(
      android.page,
      `/conversations/${conversation.id}/messages?limit=100`
    )
    expect(localStillWorks.status).toBe(200)
    expect(
      localStillWorks.body.filter((message) => message.content === '设备 B 乱序消息 3')
    ).toHaveLength(1)
    const expectedHttpError = (item) =>
      (item.status === 409 && item.url.includes('/sync/lease')) ||
      (item.status === 403 &&
        (item.url.includes('/sync/lease') || item.url.includes('/sync/changes')))
    for (const mobile of [android, iphone]) {
      expect(mobile.pageErrors).toEqual([])
      expect(mobile.httpErrors.filter((item) => !expectedHttpError(item))).toEqual([])
    }
  }, 120000)

  it('两台设备分页拉取 10k 条 outbox 变更，游标单调且无重复', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-sync-bulk-'))
    tempDirs.push(dir)
    const project = await ctx.win.evaluate((projectPath) => {
      return window.api.projects.create({ name: '万条同步验收', path: projectPath })
    }, dir)
    const { remote } = await prepareSync()
    const android = await pairDevice('android')
    const iphone = await pairDevice('iphone')
    const baseline = (await mobileApi(android.page, '/sync/status')).body.lastSeq

    const seeded = await ctx.electronApp.evaluate(
      (_electron, input) => {
        const db = globalThis.__miniagentRemoteEvents.authService.db
        const row = db.prepare("SELECT value FROM settings WHERE key='syncDeviceId'").get()
        const deviceId = JSON.parse(row.value)
        const statement = db.prepare(
          `INSERT INTO sync_changes(change_id,device_id,entity,entity_id,op,payload,base_version,new_version,created_at)
         VALUES(?,?, 'projects',?,'update',?,?,?,unixepoch()*1000)`
        )
        db.exec('BEGIN')
        try {
          for (let index = 1; index <= input.count; index++) {
            statement.run(
              `bulk-${index}`,
              deviceId,
              input.projectId,
              JSON.stringify({ id: input.projectId, name: `bulk-${index}`, updated_at: index + 1 }),
              index,
              index + 1
            )
          }
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
        return { count: input.count, deviceId }
      },
      { count: 10000, projectId: project.id }
    )
    expect(seeded.count).toBe(10000)

    async function pullAll(mobile) {
      let cursor = baseline
      let count = 0
      let pages = 0
      const ids = new Set()
      while (true) {
        const response = await mobileApi(mobile.page, `/sync/changes?after=${cursor}&limit=1000`)
        expect(response.status).toBe(200)
        expect(response.body.changes.length).toBeLessThanOrEqual(1000)
        for (const change of response.body.changes) {
          expect(ids.has(change.changeId)).toBe(false)
          ids.add(change.changeId)
        }
        count += response.body.changes.length
        pages += 1
        cursor = response.body.nextCursor
        if (!response.body.hasMs) break
        expect(pages).toBeLessThanOrEqual(12)
      }
      return { count, pages, cursor, ids }
    }

    const started = Date.now()
    const [resultA, resultB] = await Promise.all([pullAll(android), pullAll(iphone)])
    const elapsedMs = Date.now() - started
    for (const result of [resultA, resultB]) {
      expect(result.count).toBe(10000)
      expect(result.pages).toBe(10)
      expect(result.ids.has('bulk-1')).toBe(true)
      expect(result.ids.has('bulk-10000')).toBe(true)
      expect(result.cursor).toBe(baseline + 10000)
    }
    expect([...resultA.ids]).toEqual([...resultB.ids])

    const cursors = await ctx.electronApp.evaluate(
      (_electron, peerIds) => {
        const db = globalThis.__miniagentRemoteEvents.authService.db
        return peerIds.map((peerDeviceId) =>
          db.prepare('SELECT cursor FROM sync_cursors WHERE peer_device_id=?').get(peerDeviceId)
        )
      },
      [android.deviceId, iphone.deviceId]
    )
    expect(cursors.every((row) => row.cursor >= baseline + 10000)).toBe(true)
    console.info(
      `SYNC_BULK_10K devices=2 changes=10000 pages_per_device=10 elapsed_ms=${elapsedMs}`
    )
    for (const mobile of [android, iphone]) {
      expect(mobile.pageErrors).toEqual([])
      expect(mobile.httpErrors).toEqual([])
    }
    expect(remote.state.status).toBe('ready')
  }, 120000)
})
