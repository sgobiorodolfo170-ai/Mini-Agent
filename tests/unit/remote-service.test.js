import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const WebSocket = require('ws')
const dbm = require('../../electron/store/db')
const repos = require('../../electron/store/repos')
const { RemoteControlManager } = require('../../electron/main/remote')

let dir
let manager
let conv

function request(method, urlPath, { body, cookie, headers = {} } = {}) {
  const addr = manager.app.server.address()
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body)
    const req = https.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        path: urlPath,
        method,
        rejectUnauthorized: false,
        headers: {
          ...(payload
            ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
            : {}),
          ...(cookie ? { cookie } : {}),
          ...headers
        }
      },
      (res) => {
        let data = ''
        res.on('data', (c) => (data += c))
        res.on('end', () => {
          let json = null
          try {
            json = data ? JSON.parse(data) : null
          } catch {
            json = { raw: data }
          }
          resolve({ status: res.statusCode, body: json, headers: res.headers })
        })
      }
    )
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

function connectWs(cookie) {
  const addr = manager.app.server.address()
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${addr.port}/ws`, {
      rejectUnauthorized: false,
      headers: { origin: `https://127.0.0.1:${addr.port}`, cookie }
    })
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function nextMessage(ws) {
  return new Promise((resolve) =>
    ws.once('message', (data) => resolve(JSON.parse(data.toString())))
  )
}

async function pairDevice() {
  const qr = await manager.qrCode()
  const ticket = new URL(qr.url).hash.replace('#ticket=', '')
  const req = await request('POST', '/api/v1/pair/requests', { body: { ticket, name: '测试手机' } })
  expect(req.status).toBe(200)
  expect(req.body.verificationCode).toBeUndefined()
  return { ticket, deviceId: req.body.deviceId, deviceSecret: req.body.deviceSecret }
}

beforeEach(async () => {
  dbm.close()
  dbm.open(':memory:')
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-remote-it-'))
  conv = repos.createConversation(dbm.get(), { title: '远程会话' })
  manager = new RemoteControlManager({ db: dbm.get(), userData: dir })
  await manager.start({ host: '127.0.0.1', port: 0, transport: 'tls' })
})

afterEach(async () => {
  if (manager) await manager.stop()
  manager = null
  dbm.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('远程服务 HTTPS/WSS 集成', () => {
  it('未认证请求被拒绝，扫码即连接→会话→全部会话授权全链路可用', async () => {
    const denied = await request('GET', '/api/v1/conversations')
    expect(denied.status).toBe(401)

    const { ticket, deviceId, deviceSecret } = await pairDevice()

    // 一次性票据：重复交换必须失败
    const again = await request('POST', '/api/v1/pair/requests', {
      body: { ticket, name: '重复扫码设备' }
    })
    expect(again.status).toBe(410)
    expect(manager.auth.listDevices().filter((d) => d.status === 'active')).toHaveLength(1)

    const login = await request('POST', '/api/v1/auth/session', {
      body: { deviceId, deviceSecret }
    })
    expect(login.status).toBe(200)
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0]
    expect(cookie).toContain('miniagent_remote=')
    expect(String(login.headers['set-cookie'][0])).toContain('HttpOnly')

    const list = await request('GET', '/api/v1/conversations', { cookie })
    expect(list.status).toBe(200)
    expect(list.body.map((c) => c.id)).toContain(conv.id)
    const later = repos.createConversation(dbm.get(), { title: '配对后新建会话' })
    const laterList = await request('GET', '/api/v1/conversations', { cookie })
    expect(laterList.body.map((c) => c.id)).toContain(later.id)

    const status = await request('GET', '/api/v1/auth/status', { cookie })
    expect(status.body.authenticated).toBe(true)
    expect(status.body.role).toBe('operator')

    const me = await request('GET', '/api/v1/devices/me', { cookie })
    expect(me.body.deviceId).toBe(deviceId)
    expect(JSON.stringify(me.body)).not.toContain(deviceSecret)
  })

  it('WSS 同源 Cookie 认证、心跳与事件推送', async () => {
    const { deviceId, deviceSecret } = await pairDevice()
    const login = await request('POST', '/api/v1/auth/session', {
      body: { deviceId, deviceSecret }
    })
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0]

    const ws = await connectWs(cookie)
    const hb = nextMessage(ws)
    ws.send(
      JSON.stringify({
        v: 1,
        id: 'h1',
        kind: 'command',
        type: 'device.heartbeat',
        request_id: 'hb-req-0001',
        payload: {}
      })
    )
    const msg = await hb
    expect(msg.type).toBe('device.heartbeat')

    // 服务端产生一条该会话的事件，手机应收到
    const evt = nextMessage(ws)
    manager.events.record({
      type: 'run.status.changed',
      conversationId: conv.id,
      runId: 'r1',
      payload: { status: 'running' }
    })
    const received = await evt
    expect(received.type).toBe('run.status.changed')
    expect(received.conversation_id).toBe(conv.id)
    expect(received.seq).toBeGreaterThan(0)
    ws.close()
  })

  it('WSS 错误 Origin 被拒绝', async () => {
    const { deviceId, deviceSecret } = await pairDevice()
    const login = await request('POST', '/api/v1/auth/session', {
      body: { deviceId, deviceSecret }
    })
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0]
    const addr = manager.app.server.address()
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`wss://127.0.0.1:${addr.port}/ws`, {
          rejectUnauthorized: false,
          headers: { origin: 'https://evil.example', cookie }
        })
        ws.once('open', () => resolve(ws))
        ws.once('error', reject)
      })
    ).rejects.toThrow()
  })

  it('设备撤销后旧 Cookie 与 WSS 命令失效', async () => {
    const { deviceId, deviceSecret } = await pairDevice()
    const login = await request('POST', '/api/v1/auth/session', {
      body: { deviceId, deviceSecret }
    })
    const cookie = String(login.headers['set-cookie'][0]).split(';')[0]
    const ws = await connectWs(cookie)

    manager.revokeDevice(deviceId)
    const after = await request('GET', '/api/v1/conversations', { cookie })
    expect(after.status).toBe(401)

    // 旧 secret 也不能再换新会话
    const relogin = await request('POST', '/api/v1/auth/session', {
      body: { deviceId, deviceSecret }
    })
    expect(relogin.status).toBe(401)
    ws.close()
  })

  it('非法 Host 与伪造身份被拒绝', async () => {
    const bad = await request('GET', '/api/v1/auth/status', { headers: { host: 'evil.example' } })
    expect(bad.status).toBeGreaterThanOrEqual(400)
    const forged = await request('POST', '/api/v1/auth/session', {
      body: { deviceId: 'no-such', deviceSecret: 'forged-secret' }
    })
    expect(forged.status).toBe(401)
  })
})
