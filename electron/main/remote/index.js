const os = require('node:os')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const Fastify = require('fastify')
const fastifyCookie = require('@fastify/cookie')
const fastifyStatic = require('@fastify/static')
const { WebSocketServer, WebSocket } = require('ws')
const QRCode = require('qrcode')
const { RemoteAuthService } = require('./auth-service')
const { RemoteEventStore } = require('./event-store')
const { RemoteCommandRouter } = require('./router')
const { parseEnvelope, remoteError } = require('./protocol')
const certificates = require('./certificate-service')

function networkInterfaces() {
  const out = []
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const e of entries || []) {
      if (e.family !== 'IPv4' || e.internal || !e.address || e.address.startsWith('169.254.')) continue
      if (!/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(e.address)) continue
      out.push({ name, address: e.address, netmask: e.netmask, mac: e.mac, virtual: /vpn|virtual|vmware|hyper-v|loopback|tap|tun/i.test(name) })
    }
  }
  return out
}
function currentNetworkProfile() {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-Command', "(Get-NetConnectionProfile | Select-Object -First 1 -ExpandProperty NetworkCategory)"], { encoding: 'utf8', timeout: 5000, windowsHide: true })
    return out.trim() || null
  } catch { return null }
}
function cleanError(reply, error) {
  const e = error || remoteError('INTERNAL_ERROR', '服务内部错误', 500)
  return reply.code(e.status || 500).send({ error: { code: e.code || 'INTERNAL_ERROR', message: e.status ? e.message : '服务内部错误', retryable: !!e.retryable } })
}
class RemoteControlManager {
  constructor({ db, userData, notify = () => {}, mobileRoot = null }) {
    this.db = db; this.userData = userData; this.notify = notify; this.mobileRoot = mobileRoot
    this.app = null; this.wss = null; this.clients = new Set(); this.unsubscribe = null
    this.auth = new RemoteAuthService({ db, notify: () => this.changed() })
    this.events = new RemoteEventStore({ db }); this.events.authService = this.auth
    globalThis.__miniagentRemoteEvents = this.events
    this.router = new RemoteCommandRouter({ db, auth: this.auth, events: this.events })
    this.state = { status: 'stopped', host: null, port: 37651, transport: 'tls', error: null, fingerprint: null }
    this.rate = new Map(); this.lastTicket = null
  }
  changed() { this.notify({ ...this.state, devices: this.auth.listDevices(), pairings: this.auth.listPairings() }) }
  getState() { return { ...this.state, networkInterfaces: networkInterfaces(), devices: this.auth.listDevices(), pairings: this.auth.listPairings(), connectionCount: this.clients.size, eventEpoch: this.events.epoch() } }
  async qrCode() {
    if (this.state.status !== 'ready') return null
    // 每次展示都刷新一次性短票，避免过期二维码长期停留在桌面
    if (this.lastTicket) this.auth.cancelTicket(this.lastTicket.ticketId)
    this.lastTicket = this.auth.createTicket(this.state.host)
    const base = `${this.state.transport === 'tls' ? 'https' : 'http'}://${this.state.host}:${this.state.port}/pair#ticket=${this.lastTicket.ticket}`
    return { url: base, dataUrl: await QRCode.toDataURL(base, { width: 320, margin: 2 }), expiresAt: this.lastTicket.expiresAt, fingerprint: this.state.fingerprint }
  }
  rateLimit(ip, limit = 30) {
    const now = Date.now(); const bucket = this.rate.get(ip) || []
    const recent = bucket.filter((t) => now - t < 60000)
    if (recent.length >= limit) throw remoteError('RATE_LIMITED', '请求过于频繁，请稍后重试', 429, true)
    recent.push(now); this.rate.set(ip, recent)
  }
  async start({ host, port = 37651, transport = 'tls', allowPlain = false } = {}) {
    try {
      return await this._start({ host, port, transport, allowPlain })
    } catch (e) {
      // 启动失败必须回滚监听/socket，不留下半启动状态
      try { await this.stop() } catch { /* ignore */ }
      this.state = { ...this.state, status: 'stopped', error: String(e.message || e).slice(0, 300) }
      throw e
    }
  }
  async _start({ host, port = 37651, transport = 'tls', allowPlain = false } = {}) {
    if (this.app) await this.stop()
    const nic = networkInterfaces().find((n) => n.address === host) || networkInterfaces().filter((n) => !n.virtual)[0]
    if (!nic && host !== '127.0.0.1') throw new Error('未找到可用的局域网 IPv4 网卡，请检查网络连接')
    const bindHost = host || (nic && nic.address)
    if (!bindHost) throw new Error('未选择监听地址')
    if (transport !== 'tls' && !allowPlain) throw new Error('明文模式必须在桌面端明确确认风险后开启')
    if (transport !== 'tls' && transport !== 'restricted_plain') throw new Error('不支持的传输模式')
    // Windows 专用网络配置文件校验：公用网络下不开放监听
    if (process.platform === 'win32' && bindHost !== '127.0.0.1') {
      const profile = currentNetworkProfile()
      if (profile && profile.toLowerCase() !== 'private') throw new Error(`当前 Windows 网络配置文件为 ${profile}，请切换为“专用网络”后再开启远程控制`)
    }
    let https = null; let fingerprint = null
    if (transport === 'tls') {
      const cert = await certificates.ensureCertificate({ dataDir: this.userData, ip: bindHost })
      https = { key: cert.key, cert: cert.cert }; fingerprint = cert.fingerprint
    }
    const app = Fastify({ https, logger: false, bodyLimit: 65536, routerOptions: { maxParamLength: 160 }, requestTimeout: 15000 })
    this.app = app
    await app.register(fastifyCookie)
    app.addHook('onRequest', async (req, reply) => {
      reply.header('X-Content-Type-Options', 'nosniff'); reply.header('Referrer-Policy', 'no-referrer')
      reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' wss: ws:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
      if (!req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-cache')
      const expected = `${bindHost}:${app.server.address()?.port || port}`
      if (req.headers.host !== expected) throw remoteError('INVALID_HOST', '访问地址无效', 421)
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const origin = req.headers.origin
        const expectedOrigin = `${transport === 'tls' ? 'https' : 'http'}://${expected}`
        if (origin && origin !== expectedOrigin) throw remoteError('FORBIDDEN', '请求来源无效', 403)
      }
    })
    app.setErrorHandler((e, _req, reply) => { cleanError(reply, e) })
    app.addHook('preHandler', async (req) => {
      if (req.url.startsWith('/api/v1/')) {
        this.rateLimit(req.ip, req.url.includes('/pair/') || req.url.includes('/auth/session') ? 10 : 120)
        if (req.url !== '/api/v1/auth/status' && !req.url.startsWith('/api/v1/pair/') && req.url !== '/api/v1/auth/session') {
          req.remoteAuth = this.auth.authenticate(req.cookies.miniagent_remote, true)
        }
      }
    })
    const ticketOf = (req) => req.headers['x-pair-ticket'] || (req.body && req.body.ticket) || ''
    app.post('/api/v1/pair/requests', async (req) => this.auth.requestPair(ticketOf(req), req.body && req.body.name, req.ip))
    app.post('/api/v1/auth/session', async (req, reply) => {
      const r = this.auth.createSession(req.body && req.body.deviceId, req.body && req.body.deviceSecret)
      reply.setCookie('miniagent_remote', r.session, { path: '/', httpOnly: true, sameSite: 'strict', secure: transport === 'tls' })
      return { authenticated: true, role: r.device.role, csrf: r.csrf }
    })
    app.post('/api/v1/auth/logout', async (req, reply) => {
      const auth = req.remoteAuth
      this.db.prepare('UPDATE remote_sessions SET revoked_at=? WHERE session_hash=?').run(Date.now(), auth.sessionHash)
      reply.clearCookie('miniagent_remote', { path: '/' }); return { ok: true }
    })
    app.get('/api/v1/auth/status', async (req) => {
      try { const a = this.auth.authenticate(req.cookies.miniagent_remote, true); return { authenticated: true, role: a.role, authVersion: a.authVersion, epoch: this.events.epoch(), transport } }
      catch { return { authenticated: false, epoch: this.events.epoch(), transport } }
    })
    app.get('/api/v1/bootstrap', async (req) => this.events.snapshot(req.remoteAuth))
    app.get('/api/v1/conversations', async (req) => this.auth.listConversations(req.remoteAuth))
    app.post('/api/v1/conversations', async (req) => this.router.execute(req.remoteAuth, { v: 1, id: crypto.randomUUID(), kind: 'command', type: 'conversation.create', request_id: crypto.randomUUID(), payload: req.body || {} }, transport))
    app.get('/api/v1/conversations/:id/messages', async (req) => this.events.messages(req.remoteAuth, req.params.id))
    app.get('/api/v1/runs', async (req) => this.events.runs(req.remoteAuth))
    app.get('/api/v1/runs/:id/calls', async (req) => this.events.calls(req.remoteAuth, req.params.id))
    app.get('/api/v1/approvals', async (req) => { if (req.remoteAuth.role !== 'approver') throw remoteError('FORBIDDEN', '无审批权限', 403); return this.events.approvals(req.remoteAuth) })
    app.get('/api/v1/devices/me', async (req) => req.remoteAuth.device)
    app.get('/api/v1/events', async (req) => this.events.since(req.remoteAuth, req.query.after, req.query.epoch))
    // 生产 HTML 引用 ../../assets/，开发/测试环境也必须用构建产物，不能用 src 源码目录
    const root = this.mobileRoot || (process.resourcesPath
      ? path.join(process.resourcesPath, 'app.asar', 'out', 'renderer', 'entries', 'remote-mobile')
      : path.join(__dirname, '../../../out/renderer/entries/remote-mobile'))
    const hasMobile = fs.existsSync(root) && fs.existsSync(path.join(root, 'index.html'))
    const assetsRoot = hasMobile && fs.existsSync(path.join(root, '../../assets'))
      ? path.join(root, '../../assets')
      : path.join(root, 'assets')
    if (hasMobile) {
      // electron-vite 多入口 HTML 用 ../../assets/<name> 引用共享资源，浏览器会规范化成 /assets/<name>。
      // 在 static 插件之前显式注册 /assets/*，避免被 SPA fallback 或路径遍历拦截。
      if (fs.existsSync(assetsRoot)) {
        await app.register(fastifyStatic, { root: assetsRoot, prefix: '/assets/', decorateReply: false, index: false })
      }
      await app.register(fastifyStatic, { root, prefix: '/', index: ['index.html'], dotfiles: 'deny', cacheControl: false })
      app.setNotFoundHandler((req, reply) => {
        if (req.url.startsWith('/api/')) return cleanError(reply, remoteError('NOT_FOUND', '接口不存在', 404))
        if (req.method !== 'GET') return cleanError(reply, remoteError('NOT_FOUND', '资源不存在', 404))
        // 仅 SPA 路由回退，未知资源路径不得返回 index.html 造成任意文件探测
        const pathname = req.url.split('?')[0]
        if (pathname === '/' || pathname === '/pair' || pathname === '/chat' || pathname === '/index.html') return reply.sendFile('index.html')
        return cleanError(reply, remoteError('NOT_FOUND', '资源不存在', 404))
      })
    } else {
      app.get('/', async () => ({ name: 'Mini Agent Remote', status: 'mobile_not_built' }))
    }
    await app.listen({ host: bindHost, port: Number(port) })
    this.state = { status: 'ready', host: bindHost, port: app.server.address().port, transport, error: null, fingerprint }
    this.setupWebSocket(app)
    this.unsubscribe = this.events.subscribe((e) => this.broadcastEvent(e))
    this.changed()
    return this.getState()
  }
  setupWebSocket(app) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 65536, perMessageDeflate: false })
    app.server.on('upgrade', (req, socket, head) => {
      try {
        const expected = `${this.state.host}:${this.state.port}`
        const origin = `${this.state.transport === 'tls' ? 'https' : 'http'}://${expected}`
        if (req.url !== '/ws' || req.headers.host !== expected || req.headers.origin !== origin) throw new Error('forbidden')
        const cookies = Object.fromEntries(
          String(req.headers.cookie || '').split(';').map((p) => p.trim()).filter(Boolean)
            .map((p) => { const i = p.indexOf('='); return i < 0 ? [p, ''] : [p.slice(0, i), decodeURIComponent(p.slice(i + 1))] })
        )
        const auth = this.auth.authenticate(cookies.miniagent_remote, true)
        this.wss.handleUpgrade(req, socket, head, (ws) => { ws.remoteAuth = auth; this.wss.emit('connection', ws, req) })
      } catch (e) { if (process.env.MINIAGENT_REMOTE_DEBUG) console.error('WS_UPGRADE_REJECT', req.url, req.headers.host, req.headers.origin, e.message); socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy() }
    })
    this.wss.on('connection', (ws) => {
      if (this.clients.size >= 12 || [...this.clients].filter((c) => c.remoteAuth.deviceId === ws.remoteAuth.deviceId).length >= 3) { ws.close(4408, 'connection limit'); return }
      ws.isAlive = true; ws.sentBytes = 0; this.clients.add(ws)
      ws.on('pong', () => { ws.isAlive = true })
      ws.on('message', async (data, binary) => {
        try {
          if (binary || data.length > 65536) throw remoteError('PAYLOAD_TOO_LARGE', '消息过大', 413)
          const auth = this.auth.authenticate(ws.remoteAuth.sessionToken, true)
          ws.remoteAuth = auth
          const command = parseEnvelope(JSON.parse(data.toString('utf8')))
          if (command.type === 'device.heartbeat') { ws.isAlive = true; ws.send(JSON.stringify({ type: 'device.heartbeat', payload: { serverTime: Date.now() } })); return }
          const result = await this.router.execute(auth, command, this.state.transport)
          this.send(ws, { v: 1, id: crypto.randomUUID(), kind: 'command.ack', type: 'command.ack', request_id: command.request_id, payload: result, sent_at: Date.now() })
        } catch (e) {
          let requestId = null
          try { requestId = JSON.parse(data.toString()).request_id } catch { /* ignore */ }
          this.send(ws, { v: 1, id: crypto.randomUUID(), kind: 'error', type: 'protocol.error', request_id: requestId,
            error: { code: e.code || 'INVALID_MESSAGE', message: e.status ? e.message : '消息处理失败', retryable: !!e.retryable } })
          if (['SESSION_EXPIRED', 'DEVICE_REVOKED'].includes(e.code)) ws.close(4401, 'authentication expired')
        }
      })
      ws.on('close', () => this.clients.delete(ws)); ws.on('error', () => this.clients.delete(ws))
    })
    this.heartbeat = setInterval(() => {
      for (const ws of this.clients) {
        if (!ws.isAlive) { ws.terminate(); continue }
        ws.isAlive = false; ws.ping()
      }
    }, 20000)
    if (this.heartbeat.unref) this.heartbeat.unref()
  }
  send(ws, data) {
    if (ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount > 2097152) { ws.close(4413, 'backpressure'); return }
    ws.send(JSON.stringify(data))
  }
  broadcastEvent(event) {
    for (const ws of this.clients) {
      try {
        const auth = this.auth.authenticate(ws.remoteAuth.sessionToken)
        if (this.events.sendable(auth, event)) this.send(ws, event)
      } catch { ws.close(4401, 'authentication expired') }
    }
  }
  revokeDevice(id) { this.auth.revoke(id); for (const ws of this.clients) if (ws.remoteAuth.deviceId === id) ws.close(4403, 'device revoked') }
  updateDevice(id, patch) { this.auth.updateDevice(id, patch); for (const ws of this.clients) if (ws.remoteAuth.deviceId === id) ws.close(4403, 'permissions changed') }
  auditList() { return this.db.prepare('SELECT * FROM remote_audit_logs ORDER BY audit_id DESC LIMIT 200').all() }
  exportCertificate() { return certificates.exportCa({ dataDir: this.userData }) }
  async stop() {
    this.state.status = 'draining'
    if (this.unsubscribe) this.unsubscribe(); this.unsubscribe = null
    clearInterval(this.heartbeat)
    for (const ws of this.clients) ws.close(1001, 'service stopping')
    this.clients.clear()
    if (this.wss) { try { await new Promise((resolve) => this.wss.close(resolve)) } catch { /* ignore */ } }
    this.wss = null
    if (this.app) { try { await this.app.close() } catch { /* ignore */ } }
    this.app = null
    this.db.prepare('UPDATE remote_sessions SET revoked_at=? WHERE revoked_at IS NULL').run(Date.now())
    this.db.prepare("UPDATE remote_pairing_tickets SET status='cancelled' WHERE status='issued'").run()
    this.lastTicket = null; this.state.status = 'stopped'; this.changed()
  }
  static ensureWindowsFirewall(port) {
    if (process.platform !== 'win32') return { supported: false }
    const exe = path.resolve(process.execPath)
    const rule = 'Mini Agent Remote Control'
    execFileSync('netsh', ['advfirewall', 'firewall', 'add', 'rule', `name=${rule}`, 'dir=in', 'action=allow', 'protocol=TCP', `localport=${port}`, 'profile=private', 'remoteip=localsubnet', `program=${exe}`])
    return { supported: true, rule, port }
  }
}
module.exports = { RemoteControlManager, networkInterfaces }
