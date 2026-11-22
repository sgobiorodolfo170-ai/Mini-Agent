const crypto = require('node:crypto')
const { ROLES, randomToken, tokenHash, secretEqual, transaction, remoteError, cleanText, audit } = require('./protocol')

function publicDevice(row) {
  return { deviceId: row.device_id, name: row.name, role: row.role, capabilities: ROLES[row.role],
    status: row.status, authVersion: row.auth_version, lastSeenAt: row.last_seen_at, createdAt: row.created_at }
}
class RemoteAuthService {
  constructor({ db, notify = () => {} }) { this.db = db; this.notify = notify }
  createTicket(ip) {
    this.db.prepare("UPDATE remote_pairing_tickets SET status='expired' WHERE status='issued' AND expires_at<?").run(Date.now())
    const ticket = randomToken(); const id = crypto.randomUUID(); const now = Date.now()
    this.db.prepare(`INSERT INTO remote_pairing_tickets(ticket_id,ticket_hash,status,requested_ip,created_at,expires_at)
      VALUES(?,?, 'issued',?,?,?)`).run(id, tokenHash(ticket, 'pair'), ip, now, now + 180000)
    return { ticket, ticketId: id, expiresAt: now + 180000 }
  }
  cancelTicket(ticketId) {
    if (ticketId) this.db.prepare("UPDATE remote_pairing_tickets SET status='cancelled' WHERE ticket_id=? AND status='issued'").run(ticketId)
  }
  // 桌面端展示二维码即代表用户已确认；有效票据只可绑定一台设备。
  requestPair(ticket, name, ip) {
    const hash = tokenHash(ticket, 'pair')
    return transaction(this.db, () => {
      const row = this.db.prepare("SELECT * FROM remote_pairing_tickets WHERE ticket_hash=? AND status='issued'").get(hash)
      if (!row || row.expires_at <= Date.now()) throw remoteError('PAIRING_EXPIRED', '配对二维码已失效，请重新扫码', 410)
      const count = this.db.prepare("SELECT COUNT(*) AS n FROM remote_devices WHERE status='active'").get().n
      if (count >= 5) throw remoteError('DEVICE_LIMIT', '已达到设备数量上限', 409)
      const now = Date.now(); const deviceId = crypto.randomUUID(); const secret = randomToken()
      this.db.prepare(`INSERT INTO remote_devices(device_id,name,role,secret_hash,status,created_at) VALUES(?,?, 'operator',?,'active',?)`)
        .run(deviceId, cleanText(name, 40) || '手机', tokenHash(secret, `device:${deviceId}`), now)
      this.syncRoleCapabilities(deviceId, 'operator')
      const used = this.db.prepare("UPDATE remote_pairing_tickets SET status='consumed',consumed_at=?,device_name=?,requested_ip=? WHERE ticket_id=? AND status='issued'")
        .run(now, cleanText(name, 40) || '手机', cleanText(ip, 60), row.ticket_id)
      if (!used.changes) throw remoteError('STATE_CONFLICT', '配对二维码已被使用', 409)
      audit(this.db, { deviceId, actor: 'remote', action: 'pair.connected', targetId: deviceId })
      return { deviceId, deviceSecret: secret }
    })
  }
  listPairings() { return [] }
  syncRoleCapabilities(deviceId, role) {
    const capabilities = JSON.stringify(ROLES[role] || ['view'])
    const conversations = this.db.prepare('SELECT id FROM conversations WHERE deleted_at IS NULL').all()
    for (const conv of conversations) {
      this.db.prepare(`INSERT INTO remote_device_grants(device_id,conversation_id,capabilities_json,created_at) VALUES(?,?,?,?)
        ON CONFLICT(device_id,conversation_id) DO UPDATE SET capabilities_json=excluded.capabilities_json`)
        .run(deviceId, conv.id, capabilities, Date.now())
    }
  }
  createSession(deviceId, secret) {
    const device = this.db.prepare("SELECT * FROM remote_devices WHERE device_id=? AND status='active'").get(deviceId)
    if (!device || !secretEqual(device.secret_hash, tokenHash(secret, `device:${deviceId}`))) throw remoteError('UNAUTHENTICATED', '设备凭证无效', 401)
    const session = randomToken(); const csrf = randomToken(); const now = Date.now()
    this.db.prepare('UPDATE remote_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL').run(now, deviceId)
    this.db.prepare(`INSERT INTO remote_sessions(session_hash,device_id,auth_version,csrf_hash,created_at,last_seen_at,absolute_expires_at)
      VALUES(?,?,?,?,?,?,?)`).run(tokenHash(session, 'session'), deviceId, device.auth_version, tokenHash(csrf, 'csrf'), now, now, now + 43200000)
    this.db.prepare('UPDATE remote_devices SET last_seen_at=? WHERE device_id=?').run(now, deviceId)
    return { session, csrf, device: publicDevice(device) }
  }
  authenticate(session, touch = false) {
    const hash = tokenHash(session, 'session'); const now = Date.now()
    const row = this.db.prepare(`SELECT s.*,d.name,d.role,d.status,d.auth_version AS current_auth_version,d.created_at AS device_created_at
      FROM remote_sessions s JOIN remote_devices d ON d.device_id=s.device_id WHERE s.session_hash=?`).get(hash)
    if (!row || row.revoked_at || row.status !== 'active' || row.auth_version !== row.current_auth_version || row.absolute_expires_at <= now || row.last_seen_at + 1800000 <= now) {
      throw remoteError('SESSION_EXPIRED', '登录已失效，请重新验证设备', 401)
    }
    if (touch && now - row.last_seen_at > 60000) this.db.prepare('UPDATE remote_sessions SET last_seen_at=? WHERE session_hash=?').run(now, hash)
    return { sessionHash: hash, sessionToken: session, deviceId: row.device_id, role: row.role, authVersion: row.auth_version,
      device: publicDevice({ ...row, device_id: row.device_id, auth_version: row.current_auth_version, created_at: row.device_created_at }) }
  }
  requireGrant(auth, conversationId, capability = 'view') {
    if (!auth || !conversationId) throw remoteError('CONVERSATION_FORBIDDEN', '未授权该会话', 403)
    if (!this.db.prepare('SELECT id FROM conversations WHERE id=? AND deleted_at IS NULL').get(conversationId)) throw remoteError('NOT_FOUND', '会话不存在', 404)
    const capabilities = ROLES[auth.role] || []
    // 全会话访问；读取、操作和审批权限仍由设备角色严格限制。
    if (!capabilities.includes(capability)) throw remoteError('FORBIDDEN', '当前设备没有该操作权限', 403)
  }
  listConversations(_auth) {
    return this.db.prepare(`SELECT id,title,pinned,provider_id AS providerId,model,permission,origin,parent_id AS parentId,
      created_at AS createdAt,updated_at AS updatedAt FROM conversations
      WHERE deleted_at IS NULL ORDER BY pinned DESC,updated_at DESC LIMIT 100`).all()
  }
  listDevices() { return this.db.prepare('SELECT * FROM remote_devices ORDER BY created_at').all().map(publicDevice) }
  revoke(deviceId) {
    transaction(this.db, () => {
      const r = this.db.prepare("UPDATE remote_devices SET status='revoked',revoked_at=?,auth_version=auth_version+1 WHERE device_id=? AND status='active'").run(Date.now(), deviceId)
      if (!r.changes) throw remoteError('NOT_FOUND', '设备不存在或已撤销', 404)
      this.db.prepare('UPDATE remote_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL').run(Date.now(), deviceId)
      audit(this.db, { deviceId, action: 'device.revoke', targetId: deviceId })
    })
    this.notify()
  }
  updateDevice(deviceId, { role, name } = {}) {
    transaction(this.db, () => {
      const device = this.db.prepare("SELECT * FROM remote_devices WHERE device_id=? AND status='active'").get(deviceId)
      if (!device) throw remoteError('NOT_FOUND', '设备不存在或已撤销', 404)
      if (role && !ROLES[role]) throw remoteError('INVALID_MESSAGE', '设备角色无效')
      this.db.prepare('UPDATE remote_devices SET name=?,role=?,auth_version=auth_version+1 WHERE device_id=?')
        .run(cleanText(name, 40) || device.name, role || device.role, deviceId)
      if (role) this.syncRoleCapabilities(deviceId, role)
      this.db.prepare('UPDATE remote_sessions SET revoked_at=? WHERE device_id=? AND revoked_at IS NULL').run(Date.now(), deviceId)
      audit(this.db, { deviceId, action: 'device.update', targetId: deviceId })
    })
    this.notify()
  }
}
module.exports = { RemoteAuthService, publicDevice }
