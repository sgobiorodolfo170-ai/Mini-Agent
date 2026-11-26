<script setup lang="ts">
/**
 * Mini Agent 手机远程控制 H5（remote-mobile 入口）。
 * 设计依据 docs/桌面端Agent局域网远程控制完整落地方案.md：§4 配对与会话、§6 协议信封、§9 重连。
 *
 * 安全要点：
 * 1. ticket 只从 URL fragment 读取，读完立即 history.replaceState 清理，不进服务端访问日志。
 * 2. device secret 只写 sessionStorage：关闭标签页即失效，不写 localStorage/IndexedDB。
 * 3. 正文一律 Vue 文本插值，不用 v-html、不引入 markdown 渲染，避免 XSS。
 * 4. HTTP 全部同源 fetch + credentials same-origin；401 回配对页；非 2xx 抛服务端 message。
 * 5. 高风险动作（autonomous 任务、停止 Run、审批决定、退出登录）都要二次确认。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'

type Phase = 'boot' | 'pairing' | 'app'
type TabKey = 'chat' | 'runs' | 'approvals' | 'device'
type Conn = 'offline' | 'connecting' | 'online' | 'retrying'
type PairStatus = 'idle' | 'submitting' | 'expired' | 'error'
type Tone = 'info' | 'ok' | 'warn' | 'bad'

interface OfflineCommand {
  id: string
  type: string
  payload: Record<string, unknown>
  conversationId: string | null
  createdAt: number
}

interface Conversation {
  id: string
  title: string
  updatedAt?: number
}
interface Message {
  id: string
  role: string
  content: string
  status: string
  createdAt?: number
}
interface ClusterPlan {
  planId: string
  parentRunId: string
  conversationId: string
  status: string
  etag: string
  graphId?: string | null
  tasks: Array<{ key: string; goal: string; deps?: string[] }>
}

interface Run {
  id: string
  status: string
  goal: string
  control?: string
  conversationId?: string
  transferToRunId?: string
  updatedAt?: number
}
interface Approval {
  id: string
  tool: string
  risk?: string
  argsSummary?: string
  runId?: string
  conversationId?: string
  createdAt?: number
  expiresAt?: number
  version?: number
}
interface DeviceInfo {
  deviceId?: string
  name?: string
  role?: string
  capabilities?: string[]
  status?: string
  lastSeenAt?: number
}

const API_BASE = '/api/v1'
const SS_ID = 'miniagent.remote.deviceId'
const SS_SECRET = 'miniagent.remote.deviceSecret'
const SS_CSRF = 'miniagent.remote.csrf'
/** 客户端退避：1/2/4/8/16/30 秒封顶 + ±20% 抖动（§9.5） */
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000, 30000]
const BACKOFF_JITTER = 0.2
const STALE_MS = 45000 // 45s 无下行帧判为半开连接
const ACK_DEBOUNCE_MS = 600
const COMMAND_TIMEOUT_MS = 15000
const MAX_CONTENT = 16000 // 服务端普通消息正文上限
const LIST_LIMIT = 100

const TABS: { key: TabKey; label: string }[] = [
  { key: 'chat', label: '会话' },
  { key: 'runs', label: '任务' },
  { key: 'approvals', label: '审批' },
  { key: 'device', label: '设备' }
]

/* ---------------- 基础工具 ---------------- */

function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined
  if (c && typeof c.randomUUID === 'function') return c.randomUUID()
  // 非安全上下文（http + 局域网 IP）下 randomUUID 可能不可用，退回 CSPRNG 组装
  const b = new Uint8Array(16)
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(b)
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256)
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

/** 只取第一个有值的字段，兼容服务端 camelCase / snake_case 两种命名 */
function field<T = string>(o: unknown, names: string[], fallback: T | '' = ''): T | '' {
  if (!o || typeof o !== 'object') return fallback
  const rec = o as Record<string, unknown>
  for (const n of names) {
    const v = rec[n]
    if (v !== undefined && v !== null && v !== '') return v as T
  }
  return fallback
}

function text(v: unknown, max = 400): string {
  if (v === undefined || v === null) return ''
  const s = typeof v === 'string' ? v : String(v)
  return s.length > max ? s.slice(0, max) + '…' : s
}

function fmtTime(ts?: number): string {
  if (!ts) return '—'
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return '—'
  const today = new Date()
  const sameDay = d.toDateString() === today.toDateString()
  const hm = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return sameDay
    ? hm
    : d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' }) + ' ' + hm
}

function fmtCountdown(ms?: number): string {
  if (!ms) return ''
  const left = Math.round((ms - Date.now()) / 1000)
  if (left <= 0) return '已过期'
  if (left < 60) return `${left} 秒后过期`
  return `${Math.ceil(left / 60)} 分钟后过期`
}

function guessDeviceName(): string {
  const ua = navigator.userAgent || ''
  const os = /Android/i.test(ua)
    ? 'Android'
    : /iPhone|iPod|iPad/i.test(ua)
      ? 'iOS'
      : /Windows/i.test(ua)
        ? 'Windows'
        : /Mac OS X/i.test(ua)
          ? 'macOS'
          : '移动设备'
  const browser = /MicroMessenger/i.test(ua)
    ? '微信'
    : /Edg\//i.test(ua)
      ? 'Edge'
      : /Firefox\//i.test(ua)
        ? 'Firefox'
        : /Chrome\//i.test(ua)
          ? 'Chrome'
          : /Safari/i.test(ua)
            ? 'Safari'
            : '浏览器'
  return text(`${browser} · ${os}`, 40) || '手机'
}

/* ---------------- HTTP 封装 ---------------- */

class ApiError extends Error {
  status: number
  code: string
  retryable: boolean
  constructor(status: number, message: string, code = 'HTTP_ERROR', retryable = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e
  return new ApiError(0, text((e as Error)?.message) || '请求失败', 'CLIENT_ERROR', true)
}

function messageOf(e: unknown): string {
  const err = toApiError(e)
  const suffix = err.code && err.code !== 'HTTP_ERROR' ? `（${err.code}）` : ''
  return text(err.message, 300) + suffix
}

function parseError(status: number, raw: unknown): ApiError {
  const o = (raw ?? {}) as Record<string, unknown>
  const inner = (o.error ?? o) as Record<string, unknown>
  const message = text(inner?.message ?? o?.message ?? `请求失败（HTTP ${status}）`, 300)
  const code = text(
    inner?.code ?? o?.code ?? (status === 401 ? 'UNAUTHENTICATED' : 'HTTP_ERROR'),
    40
  )
  return new ApiError(
    status,
    message || `请求失败（HTTP ${status}）`,
    code,
    Boolean(inner?.retryable)
  )
}

async function http<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {}
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json', ...opts.headers }
  if (opts.body !== undefined) headers['content-type'] = 'application/json'
  const method = (opts.method ?? (opts.body !== undefined ? 'POST' : 'GET')).toUpperCase()
  const needsCsrf =
    !['GET', 'HEAD'].includes(method) && path !== '/auth/session' && path !== '/pair/requests'
  if (needsCsrf && credentials.csrf) headers['x-csrf-token'] = credentials.csrf
  let res: Response
  try {
    res = await fetch(API_BASE + path, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      credentials: 'same-origin',
      cache: 'no-store'
    })
  } catch {
    throw new ApiError(
      0,
      '无法连接桌面服务：请确认手机与电脑在同一网络、远程服务已开启，并已信任本地证书',
      'NETWORK_ERROR',
      true
    )
  }
  const raw = await res.text()
  let data: unknown = null
  if (raw) {
    try {
      data = JSON.parse(raw)
    } catch {
      data = { message: raw.slice(0, 200) }
    }
  }
  if (!res.ok) throw parseError(res.status, data)
  return data as T
}

/* ---------------- 全局状态 ---------------- */

const phase = ref<Phase>('boot')
const booting = ref(true)
const tab = ref<TabKey>('chat')
const conn = ref<Conn>('offline')
const lastEventAt = ref(0)
const insecure = ref(false) // 当前是 http/ws，页面持续显示非加密提示
const toasts = reactive<{ id: string; tone: Tone; message: string }[]>([])
const streamEpoch = ref('')
const lastSeq = ref(0)
const serverAuth = reactive({ authenticated: false, role: '', authVersion: 0, epoch: '' })

const credentials = reactive({ deviceId: '', deviceSecret: '', csrf: '' })
const device = reactive<DeviceInfo & Record<string, unknown>>({})
const capability = computed(() => {
  const role =
    text(field(device, ['role', 'deviceRole']), 20).toLowerCase() ||
    text(serverAuth.role, 20).toLowerCase()
  const list = Array.isArray(device.capabilities)
    ? device.capabilities.map((c) => text(c, 24).toLowerCase())
    : []
  return {
    role: role || '未知',
    viewer: list.length ? list.includes('view') || list.includes('conversation.read') : role !== '',
    operator: list.length
      ? list.includes('operate') ||
        list.includes('agent.run.start') ||
        list.includes('chat.message.send')
      : role === 'operator',
    approver: list.length
      ? list.includes('approve') || list.includes('approval.respond')
      : role === 'approver'
  }
})

/* 配对状态 */
const pair = reactive<{
  ticket: string
  name: string
  status: PairStatus
  error: string
}>({
  ticket: '',
  name: guessDeviceName(),
  status: 'idle',
  error: ''
})

function pushToast(tone: Tone, message: string): void {
  const id = uuid()
  toasts.push({ id, tone, message })
  window.setTimeout(
    () => {
      const i = toasts.findIndex((t) => t.id === id)
      if (i >= 0) toasts.splice(i, 1)
    },
    tone === 'bad' ? 6000 : 3500
  )
}

/* ---------------- sessionStorage 凭证 ---------------- */

function readStoredCreds(): boolean {
  try {
    credentials.deviceId = sessionStorage.getItem(SS_ID) || ''
    credentials.deviceSecret = sessionStorage.getItem(SS_SECRET) || ''
    credentials.csrf = sessionStorage.getItem(SS_CSRF) || ''
  } catch {
    credentials.deviceId = ''
    credentials.deviceSecret = ''
    credentials.csrf = ''
  }
  return Boolean(credentials.deviceId && credentials.deviceSecret)
}

function saveCreds(deviceId: string, secret: string, csrf = ''): void {
  credentials.deviceId = deviceId
  credentials.deviceSecret = secret
  credentials.csrf = csrf
  try {
    sessionStorage.setItem(SS_ID, deviceId)
    sessionStorage.setItem(SS_SECRET, secret)
    if (csrf) sessionStorage.setItem(SS_CSRF, csrf)
    else sessionStorage.removeItem(SS_CSRF)
  } catch {
    pushToast('warn', '浏览器拒绝写入 sessionStorage，本次会话凭证仅保存在当前页面内存中')
  }
}

function clearCreds(): void {
  credentials.deviceId = ''
  credentials.deviceSecret = ''
  credentials.csrf = ''
  try {
    sessionStorage.removeItem(SS_ID)
    sessionStorage.removeItem(SS_SECRET)
    sessionStorage.removeItem(SS_CSRF)
  } catch {
    /* 隐私模式下忽略 */
  }
}

/* ---------------- ticket 读取与地址栏清理 ---------------- */

function extractTicket(): string {
  let ticket = ''
  const hash = location.hash || ''
  const frag = hash.replace(/^#/, '')
  const pairs = [frag, location.search.replace(/^\?/, '')]
  for (const src of pairs) {
    if (ticket) break
    for (const part of src.split('&')) {
      const eq = part.indexOf('=')
      const key = (eq < 0 ? part : part.slice(0, eq)).trim()
      if (key !== 'ticket' && key !== 't') continue
      const value = decodeURIComponent((eq < 0 ? '' : part.slice(eq + 1)).trim())
      if (/^[A-Za-z0-9_-]{8,128}$/.test(value)) ticket = value
    }
  }
  // 立刻清理地址栏与历史条目，避免 ticket 留在可见 URL / 复制分享里
  try {
    history.replaceState(
      null,
      '',
      location.pathname + location.search.replace(/[?&](ticket|t)=[^&]*/g, '').replace(/^&/, '?')
    )
  } catch {
    location.hash = ''
  }
  return ticket
}

/* ---------------- 会话建立 / 恢复 ---------------- */

async function refreshAuthStatus(): Promise<boolean> {
  try {
    const data = await http<Record<string, unknown>>('/auth/status')
    const auth = (field(data, ['authenticated', 'auth', 'loggedIn']) || false) as boolean
    serverAuth.authenticated = Boolean(auth)
    serverAuth.role = text(field(data, ['role', 'deviceRole']), 20).toLowerCase()
    serverAuth.authVersion = Number(field(data, ['authVersion', 'auth_version', 'version'], 0)) || 0
    serverAuth.epoch = text(field(data, ['epoch', 'streamEpoch', 'stream_epoch']), 64)
    return serverAuth.authenticated
  } catch (e) {
    const err = toApiError(e)
    if (err.status === 401) return false
    pushToast('warn', messageOf(e))
    return false
  }
}

async function createSession(): Promise<boolean> {
  if (!credentials.deviceId || !credentials.deviceSecret) return false
  try {
    const data = await http<Record<string, unknown>>('/auth/session', {
      method: 'POST',
      body: { deviceId: credentials.deviceId, deviceSecret: credentials.deviceSecret }
    })
    const csrf = text(field(data, ['csrf', 'csrfToken', 'csrf_token']), 128)
    if (!csrf) {
      pushToast('bad', '会话建立失败：服务端未返回安全凭证')
      return false
    }
    saveCreds(credentials.deviceId, credentials.deviceSecret, csrf)
    return true
  } catch (e) {
    const err = toApiError(e)
    if (
      err.status === 401 ||
      err.status === 403 ||
      err.code === 'DEVICE_REVOKED' ||
      err.code === 'SESSION_EXPIRED'
    ) {
      clearCreds()
      pushToast('warn', '设备凭证已失效或被撤销，请重新扫码配对')
      return false
    }
    pushToast('bad', messageOf(e))
    return false
  }
}

async function loadSelf(): Promise<void> {
  try {
    const data = await http<Record<string, unknown>>('/devices/me')
    Object.assign(device, data)
    const r = text(field(data, ['role', 'deviceRole']), 20).toLowerCase()
    if (r) serverAuth.role = r
  } catch (e) {
    device.role = device.role || serverAuth.role
    pushToast('warn', '设备信息读取失败：' + messageOf(e))
  }
}

async function loadBootstrap(): Promise<void> {
  try {
    const data = await http<Record<string, unknown>>('/bootstrap')
    const epoch = text(field(data, ['epoch', 'stream_epoch', 'streamEpoch']), 64)
    if (epoch) streamEpoch.value = epoch
    const seq = Number(field(data, ['snapshot_seq', 'snapshotSeq', 'seq'], 0))
    if (Number.isFinite(seq) && seq > 0) lastSeq.value = seq
  } catch (e) {
    const err = toApiError(e)
    if (err.status !== 404) pushToast('warn', '快照信息读取失败：' + messageOf(err.message))
  }
}

async function enterApp(): Promise<void> {
  phase.value = 'app'
  booting.value = false
  await Promise.all([loadSelf(), loadBootstrap()])
  await nextTick()
  void loadConversations()
  void loadRuns()
  void loadApprovals()
  connectSocket()
  startWatchdog()
}

async function boot(): Promise<void> {
  insecure.value = location.protocol !== 'https:'
  const ticket = extractTicket()
  if (ticket) pair.ticket = ticket
  const hasCreds = readStoredCreds()
  let ok = await refreshAuthStatus()
  if (ok && !credentials.csrf) {
    // 兼容升级前已建立但尚未保存 CSRF Token 的会话；无设备凭证时重新配对。
    ok = hasCreds ? await createSession() : false
    if (ok) serverAuth.authenticated = true
  } else if (!ok && hasCreds) {
    ok = await createSession() // 刷新后凭 sessionStorage 中的短期凭证恢复会话
    if (ok) serverAuth.authenticated = true
  }
  if (ok) {
    await enterApp()
    return
  }
  clearCreds()
  offlineQueue.value = []
  persistOfflineQueue()
  phase.value = 'pairing'
  booting.value = false
  if (pair.ticket) void startPairing()
}

function goPairing(message?: string): void {
  closeSocket()
  stopWatchdog()
  clearCreds()
  offlineQueue.value = []
  persistOfflineQueue()
  serverAuth.authenticated = false
  phase.value = 'pairing'
  pair.status = 'idle'
  pair.error = message || ''
  conversations.value = []
  messages.value = []
  runs.value = []
  plans.value = []
  approvals.value = []
}

/* ---------------- 配对流程 ---------------- */

async function startPairing(): Promise<void> {
  pair.error = ''
  const ticket = pair.ticket.trim()
  if (!ticket) {
    pair.error = '没有从链接中读到配对码，请使用桌面端生成的二维码链接打开本页'
    return
  }
  if (!pair.name.trim()) pair.name = guessDeviceName()
  pair.status = 'submitting'
  try {
    const data = await http<Record<string, unknown>>('/pair/requests', {
      method: 'POST',
      body: { ticket, name: pair.name.trim().slice(0, 40) }
    })
    const deviceId = text(field(data, ['deviceId', 'device_id']), 64)
    const secret = text(field(data, ['deviceSecret', 'device_secret']), 128)
    if (!deviceId || !secret) {
      pair.status = 'error'
      pair.error = '配对响应缺少设备凭证，请重新扫码'
      return
    }
    saveCreds(deviceId, secret)
    pair.ticket = '' // 一次性票据已消费，立即丢弃
    if (!(await createSession())) {
      pair.status = 'error'
      pair.error = '设备已连接，但会话建立失败，请重新扫码'
      return
    }
    serverAuth.authenticated = true
    await enterApp()
    pushToast('ok', '连接成功，已进入远程控制')
  } catch (e) {
    pair.status = 'error'
    pair.error = messageOf(e)
  }
}

async function logout(): Promise<void> {
  if (
    !(await confirmAction({
      title: '退出登录',
      message: '退出当前会话并撤销短期凭证，设备仍可稍后用新配对链接重新接入。'
    }))
  )
    return
  busy.logout = true
  try {
    await http('/auth/logout', { method: 'POST', body: {} })
  } catch (e) {
    pushToast('warn', messageOf(e))
  } finally {
    busy.logout = false
  }
  goPairing('已退出登录')
}

/* ---------------- WebSocket：命令信封与事件 ---------------- */

const WS_PATH = '/ws'

let socket: WebSocket | null = null
let reconnectTimer: number | null = null
let heartbeatTimer: number | null = null
let watchdogTimer: number | null = null
let ackTimer: number | null = null
let reconnectAttempt = 0
let socketClosing = false
const pending = new Map<string, { type: string; timer: number }>()
const OFFLINE_QUEUE_KEY = 'miniagent_remote_offline_v1'
const offlineQueue = ref<OfflineCommand[]>(readOfflineQueue())

function readOfflineQueue(): OfflineCommand[] {
  try {
    const raw = JSON.parse(localStorage.getItem(OFFLINE_QUEUE_KEY) || '[]')
    if (!Array.isArray(raw)) return []
    return raw
      .filter(
        (item) =>
          item &&
          typeof item.id === 'string' &&
          typeof item.type === 'string' &&
          item.payload &&
          typeof item.payload === 'object'
      )
      .slice(-100)
  } catch {
    return []
  }
}

function persistOfflineQueue(): void {
  try {
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(offlineQueue.value))
  } catch {
    pushToast('warn', '离线队列无法写入本地存储，请保持页面打开')
  }
}

function enqueueOfflineCommand(
  type: string,
  payload: Record<string, unknown>,
  conversationId: string | null
): string {
  const item: OfflineCommand = {
    id: uuid(),
    type,
    payload,
    conversationId,
    createdAt: Date.now()
  }
  offlineQueue.value.push(item)
  if (offlineQueue.value.length > 100) offlineQueue.value.shift()
  persistOfflineQueue()
  return item.id
}

function flushOfflineQueue(): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  for (const item of offlineQueue.value) {
    if (pending.has(item.id)) continue
    const requestId = sendCommand(item.type, item.payload, item.conversationId, item.id)
    if (!requestId) break
  }
}

function removeOfflineCommand(requestId: string): void {
  const index = offlineQueue.value.findIndex((item) => item.id === requestId)
  if (index < 0) return
  offlineQueue.value.splice(index, 1)
  persistOfflineQueue()
}

function wsUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}${WS_PATH}`
}

function clearTimer(ref: 'reconnect' | 'heartbeat' | 'watchdog' | 'ack'): void {
  const map = {
    reconnect: reconnectTimer,
    heartbeat: heartbeatTimer,
    watchdog: watchdogTimer,
    ack: ackTimer
  }
  const id = map[ref]
  if (id !== null) window.clearTimeout(id)
  if (ref === 'reconnect') reconnectTimer = null
  else if (ref === 'heartbeat') heartbeatTimer = null
  else if (ref === 'watchdog') watchdogTimer = null
  else ackTimer = null
}

function connectSocket(): void {
  if (phase.value !== 'app') return
  closeSocket()
  socketClosing = false
  conn.value = reconnectAttempt === 0 ? 'connecting' : 'retrying'
  let ws: WebSocket
  try {
    ws = new WebSocket(wsUrl()) // Cookie 由浏览器自动同源携带，URL 不含任何凭证
  } catch (e) {
    conn.value = 'offline'
    scheduleReconnect()
    pushToast('warn', '实时通道创建失败：' + messageOf(e))
    return
  }
  socket = ws
  ws.onopen = () => {
    if (socket !== ws) return
    conn.value = 'online'
    reconnectAttempt = 0
    lastEventAt.value = Date.now()
    sendRaw({
      v: 1,
      id: uuid(),
      kind: 'command',
      type: 'session.subscribe',
      request_id: uuid(),
      conversation_id: activeConversationId.value || null,
      payload: { epoch: streamEpoch.value || null, after_seq: lastSeq.value }
    })
    flushOfflineQueue()
    clearTimer('heartbeat')
    heartbeatTimer = window.setInterval(() => {
      if (socket && socket.readyState === WebSocket.OPEN) {
        sendRaw({
          v: 1,
          id: uuid(),
          kind: 'command',
          type: 'device.heartbeat',
          request_id: uuid(),
          conversation_id: null,
          payload: {}
        })
      }
    }, 20000)
    clearTimer('watchdog')
    watchdogTimer = window.setInterval(checkStale, 5000)
  }
  ws.onmessage = (ev: MessageEvent<string>) => {
    if (socket !== ws) return
    lastEventAt.value = Date.now()
    handleFrame(ev.data)
  }
  ws.onclose = (ev: CloseEvent) => {
    if (socket !== ws) return
    socket = null
    clearTimer('heartbeat')
    clearTimer('watchdog')
    failAllPending('实时连接已断开')
    if (socketClosing || phase.value !== 'app') {
      conn.value = 'offline'
      return
    }
    if (ev.code === 4401 || ev.code === 4403) {
      conn.value = 'offline'
      goPairing('设备凭证或会话已失效，请重新配对')
      return
    }
    conn.value = 'retrying'
    scheduleReconnect()
  }
  ws.onerror = () => {
    if (socket !== ws) return
    conn.value = 'retrying'
  }
}

function closeSocket(): void {
  socketClosing = true
  clearTimer('reconnect')
  clearTimer('heartbeat')
  clearTimer('watchdog')
  clearTimer('ack')
  const ws = socket
  socket = null
  if (ws) {
    try {
      ws.onclose = null
      ws.onmessage = null
      ws.onerror = null
      ws.onopen = null
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)
        ws.close(1000, 'client')
    } catch {
      /* 忽略关闭异常 */
    }
  }
  conn.value = 'offline'
}

function scheduleReconnect(): void {
  if (reconnectTimer !== null) return
  const base = BACKOFF_MS[Math.min(reconnectAttempt, BACKOFF_MS.length - 1)]
  reconnectAttempt += 1
  const delay = Math.round(base * (1 + (Math.random() * 2 - 1) * BACKOFF_JITTER))
  conn.value = 'retrying'
  reconnectTimer = window.setTimeout(
    () => {
      reconnectTimer = null
      if (phase.value !== 'app') return
      if (!serverAuth.authenticated) {
        void refreshAuthStatus().then((ok) => (ok ? connectSocket() : goPairing('登录状态已过期')))
        return
      }
      connectSocket()
    },
    Math.max(500, delay)
  )
}

function checkStale(): void {
  if (conn.value !== 'online') return
  if (Date.now() - lastEventAt.value < STALE_MS) return
  pushToast('warn', '实时通道长时间无响应，正在重建连接')
  const ws = socket
  socket = null
  try {
    ws?.close(1000, 'stale')
  } catch {
    /* 忽略 */
  }
  conn.value = 'retrying'
  scheduleReconnect()
}

function sendRaw(msg: Record<string, unknown>): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  try {
    socket.send(JSON.stringify(msg))
    return true
  } catch (e) {
    pushToast('bad', '发送失败：' + messageOf(e))
    return false
  }
}

/** 业务命令：统一信封 {v,id,kind:'command',type,request_id,conversation_id,payload} */
function sendCommand(
  type: string,
  payload: Record<string, unknown>,
  conversationId: string | null = null,
  requestId: string = uuid()
): string | null {
  const ok = sendRaw({
    v: 1,
    id: uuid(),
    kind: 'command',
    type,
    request_id: requestId,
    conversation_id: conversationId,
    payload
  })
  if (!ok) return null
  const timer = window.setTimeout(() => {
    if (!pending.has(requestId)) return
    pending.delete(requestId)
    pushToast('warn', `${labelOf(type)} 没有收到回执，可能是桌面端仍在执行，请稍后刷新查看`)
  }, COMMAND_TIMEOUT_MS)
  pending.set(requestId, { type, timer })
  return requestId
}

function failAllPending(reason: string): void {
  for (const [id, item] of pending) {
    window.clearTimeout(item.timer)
    pending.delete(id)
    if (
      item.type !== 'session.subscribe' &&
      item.type !== 'device.heartbeat' &&
      item.type !== 'events.ack'
    ) {
      pushToast('warn', `${labelOf(item.type)}：${reason}`)
    }
  }
}

const COMMAND_LABELS: Record<string, string> = {
  'chat.message.send': '发送消息',
  'chat.message.stop': '停止生成',
  'agent.run.start': '启动任务',
  'agent.run.pause': '请求暂停',
  'agent.run.resume': '请求继续',
  'agent.run.retry': '恢复中断任务',
  'agent.run.stop': '请求停止',
  'agent.plan.confirm': '确认集群计划',
  'agent.plan.reject': '拒绝集群计划',
  'approval.respond': '提交审批决定'
}
function labelOf(type: string): string {
  return COMMAND_LABELS[type] || type
}

function settleAck(requestId: string, status: string, detail: unknown): void {
  const item = pending.get(requestId)
  if (!item) return
  pending.delete(requestId)
  window.clearTimeout(item.timer)
  const s = status.toLowerCase()
  if (s === 'accepted' || s === 'completed') {
    removeOfflineCommand(requestId)
    const queued = messages.value.find((message) => message.id === requestId)
    if (queued) queued.status = 'sent'
    if (s === 'completed' && item.type === 'chat.message.send') {
      const msg = (detail ?? {}) as Record<string, unknown>
      const id = text(field(msg, ['messageId', 'message_id', 'id']), 64)
      const content = text(field(msg, ['content']), MAX_CONTENT)
      if (id && content) upsertMessage({ id, role: 'assistant', content, status: 'done' })
    }
    return
  }
  const err = (detail ?? {}) as Record<string, unknown>
  const message =
    text(err?.message ?? (typeof detail === 'string' ? detail : ''), 200) || '服务端未接受该命令'
  pushToast('bad', `${labelOf(item.type)}失败：${message}`)
  removeOfflineCommand(requestId)
  const failed = messages.value.find((message) => message.id === requestId)
  if (failed) failed.status = 'error'
}

function handleFrame(raw: string): void {
  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(raw) as Record<string, unknown>
  } catch {
    pushToast('warn', '收到无法解析的实时消息，已忽略')
    return
  }
  const kind = text(field(msg, ['kind']), 24).toLowerCase()
  const type = text(field(msg, ['type']), 64).toLowerCase()
  const seq = Number(field(msg, ['seq'], 0))
  if (Number.isFinite(seq) && seq > 0) lastSeq.value = Math.max(lastSeq.value, seq)
  const epoch = text(field(msg, ['stream_epoch', 'epoch']), 64)
  if (epoch && epoch !== streamEpoch.value) {
    streamEpoch.value = epoch
    if (lastSeq.value) pushToast('info', '桌面端事件流已重置，正在重新同步')
  }
  const payload = (field(msg, ['payload'], {}) || {}) as Record<string, unknown>
  const conversationId = text(field(msg, ['conversation_id', 'conversationId']), 64)

  if (kind === 'command.ack' || kind === 'ack') {
    settleAck(
      text(field(msg, ['request_id', 'requestId']), 64),
      text(field(msg, ['status', 'state'], 'accepted'), 24),
      msg.result ?? msg.error ?? payload
    )
    return
  }
  if (kind === 'protocol.error' || type === 'protocol.error') {
    pushToast('bad', text(payload?.message ?? msg?.message ?? '协议错误', 200))
    return
  }
  if (kind !== 'event' && kind !== 'snapshot') return

  if (type.startsWith('message.delta')) {
    const id = text(field(payload, ['message_id', 'messageId', 'id']), 64)
    const delta = text(field(payload, ['delta', 'content']), MAX_CONTENT)
    if (!id || !delta) return
    if (conversationId && conversationId !== activeConversationId.value) return
    appendDelta(id, delta, conversationId)
    scheduleAck(seq)
    return
  }
  if (type.startsWith('message.completed') || type.startsWith('message.done')) {
    const id = text(field(payload, ['message_id', 'messageId', 'id']), 64)
    const content = text(field(payload, ['content', 'text']), MAX_CONTENT)
    const msgRole = text(field(payload, ['role'], 'assistant'), 16)
    const status = text(field(payload, ['status'], 'done'), 24) || 'done'
    if (id) upsertMessage({ id, role: msgRole || 'assistant', content, status, conversationId })
    if (type.includes('failed') || type.includes('error')) markMessageStatus(id, 'error')
    scheduleAck(seq)
    return
  }
  if (type.startsWith('cluster.plan.')) {
    applyPlanEvent(type, payload, conversationId)
    scheduleAck(seq)
    return
  }
  if (type.startsWith('run.')) {
    applyRunEvent(type, payload, conversationId)
    scheduleAck(seq)
    return
  }
  if (type.startsWith('approval.')) {
    applyApprovalEvent(type, payload)
    scheduleAck(seq)
    return
  }
  if (type.startsWith('device.') || type.startsWith('auth.') || type.includes('revoked')) {
    if (
      type.includes('revoked') ||
      type.includes('unauthenticated') ||
      type.includes('session.expired')
    ) {
      goPairing('桌面端已撤销本设备或会话已过期')
      return
    }
    void loadSelf()
    return
  }
  if (type.startsWith('conversation.')) {
    void loadConversations()
  }
}

function scheduleAck(seq: number): void {
  if (!seq) return
  if (ackTimer !== null) return
  ackTimer = window.setTimeout(() => {
    ackTimer = null
    sendRaw({
      v: 1,
      id: uuid(),
      kind: 'command',
      type: 'events.ack',
      request_id: uuid(),
      conversation_id: null,
      payload: { seq: lastSeq.value, epoch: streamEpoch.value || null }
    })
  }, ACK_DEBOUNCE_MS)
}

function startWatchdog(): void {
  document.addEventListener('visibilitychange', onVisibility)
  window.addEventListener('pageshow', onPageShow)
  window.addEventListener('focus', onPageShow)
}

function stopWatchdog(): void {
  document.removeEventListener('visibilitychange', onVisibility)
  window.removeEventListener('pageshow', onPageShow)
  window.removeEventListener('focus', onPageShow)
}

/** 回前台立即核对 auth/status 与 socket，不假设后台连接仍活跃（§9.5） */
async function resumeSync(): Promise<void> {
  if (phase.value !== 'app') return
  const ok = await refreshAuthStatus()
  if (!ok) {
    goPairing('登录状态已过期，请重新配对')
    return
  }
  const dead =
    !socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING
  if (dead || Date.now() - lastEventAt.value > STALE_MS) {
    lastEventAt.value = Date.now()
    reconnectAttempt = 0
    connectSocket()
  }
  await Promise.all([loadConversations(), loadRuns(), loadApprovals()])
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') void resumeSync()
}

function onPageShow(e: PageTransitionEvent | Event): void {
  if (e instanceof PageTransitionEvent && !e.persisted && phase.value === 'app') void resumeSync()
  else if (!(e instanceof PageTransitionEvent)) void resumeSync()
}

/* ---------------- 数据加载（REST） ---------------- */

const conversations = ref<Conversation[]>([])
const messages = ref<Message[]>([])
const runs = ref<Run[]>([])
const plans = ref<ClusterPlan[]>([])
const approvals = ref<Approval[]>([])
const activeConversationId = ref('')
const busy = reactive({
  conversations: false,
  messages: false,
  runs: false,
  approvals: false,
  logout: false,
  send: false
})
const loading = {
  conversations: computed(() => busy.conversations),
  messages: computed(() => busy.messages)
}
void loading

function normalizeConversation(o: Record<string, unknown>): Conversation {
  return {
    id: text(field(o, ['id', 'conversationId', 'conversation_id']), 64),
    title: text(field(o, ['title', 'name']), 60) || '未命名会话',
    updatedAt: Number(field(o, ['updatedAt', 'updated_at', 'lastMessageAt'], 0)) || 0
  }
}

function normalizeMessage(o: Record<string, unknown>): Message | null {
  const id = text(field(o, ['id', 'messageId', 'message_id']), 64)
  if (!id) return null
  return {
    id,
    role: text(field(o, ['role'], 16)).toLowerCase() || 'assistant',
    content: text(field(o, ['content', 'text', 'body'], MAX_CONTENT), MAX_CONTENT),
    status: text(field(o, ['status', 'state'], 16)) || 'done',
    createdAt: Number(field(o, ['createdAt', 'created_at', 'seq'], 0)) || 0
  }
}

function normalizeRun(o: Record<string, unknown>): Run | null {
  const id = text(field(o, ['id', 'runId', 'run_id']), 64)
  if (!id) return null
  return {
    id,
    status: text(field(o, ['status', 'state'], 24)).toLowerCase() || 'queued',
    goal: text(field(o, ['goal', 'objective', 'title'], 200)) || '未命名任务',
    control: text(field(o, ['control', 'controlStatus', 'control_status']), 24),
    conversationId: text(field(o, ['conversationId', 'conversation_id']), 64),
    transferToRunId: text(field(o, ['transferToRunId', 'transfer_to_run_id']), 64),
    updatedAt: Number(field(o, ['updatedAt', 'updated_at', 'createdAt'], 0)) || 0
  }
}

function normalizeApproval(o: Record<string, unknown>): Approval | null {
  const id = text(field(o, ['id', 'approvalId', 'approval_id']), 64)
  if (!id) return null
  return {
    id,
    tool: text(field(o, ['tool', 'toolName', 'tool_name', 'name']), 48) || '未知工具',
    risk: text(field(o, ['risk', 'riskLevel'], 16)),
    argsSummary: text(field(o, ['argsSummary', 'args_summary', 'argumentsSummary'], 600), 600),
    runId: text(field(o, ['runId', 'run_id']), 64),
    conversationId: text(field(o, ['conversationId', 'conversation_id']), 64),
    createdAt: Number(field(o, ['createdAt', 'created_at'], 0)) || 0,
    expiresAt: Number(field(o, ['expiresAt', 'expires_at'], 0)) || 0,
    version: Number(field(o, ['version'], 1)) || 0
  }
}

function listOf(data: unknown, keys: string[]): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[]
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>
    for (const k of keys) if (Array.isArray(rec[k])) return rec[k] as Record<string, unknown>[]
    for (const v of Object.values(rec)) if (Array.isArray(v)) return v as Record<string, unknown>[]
  }
  return []
}

async function loadConversations(): Promise<void> {
  if (phase.value !== 'app') return
  busy.conversations = true
  try {
    const data = await http<unknown>(`/conversations?limit=${LIST_LIMIT}`)
    conversations.value = listOf(data, ['conversations', 'items', 'list'])
      .map(normalizeConversation)
      .filter((c) => c.id)
    if (!activeConversationId.value && conversations.value.length)
      void selectConversation(conversations.value[0].id)
  } catch (e) {
    const err = toApiError(e)
    if (err.status === 401) goPairing('登录状态已过期')
    else pushToast('warn', '会话列表加载失败：' + messageOf(err))
  } finally {
    busy.conversations = false
  }
}

async function selectConversation(id: string): Promise<void> {
  if (!id || activeConversationId.value === id) {
    if (!id) return
  }
  activeConversationId.value = id
  await loadMessages()
}

async function loadMessages(): Promise<void> {
  if (!activeConversationId.value) {
    messages.value = []
    return
  }
  busy.messages = true
  try {
    const data = await http<unknown>(
      `/conversations/${encodeURIComponent(activeConversationId.value)}/messages?limit=${LIST_LIMIT}`
    )
    const rows = listOf(data, ['messages', 'items', 'list'])
      .map(normalizeMessage)
      .filter((m): m is Message => Boolean(m))
    messages.value = rows
    await scrollMessages()
  } catch (e) {
    const err = toApiError(e)
    if (err.status === 401) goPairing('登录状态已过期')
    else pushToast('warn', '消息加载失败：' + messageOf(err))
  } finally {
    busy.messages = false
  }
}

async function loadRuns(): Promise<void> {
  if (phase.value !== 'app') return
  busy.runs = true
  try {
    const data = await http<unknown>(`/runs?limit=${LIST_LIMIT}`)
    runs.value = listOf(data, ['runs', 'items', 'list'])
      .map(normalizeRun)
      .filter((r): r is Run => Boolean(r))
  } catch (e) {
    const err = toApiError(e)
    if (err.status === 401) goPairing('登录状态已过期')
    else pushToast('warn', '任务列表加载失败：' + messageOf(err))
  } finally {
    busy.runs = false
  }
}

async function loadApprovals(): Promise<void> {
  if (phase.value !== 'app') return
  if (!capability.value.approver) {
    approvals.value = []
    busy.approvals = false
    return
  }
  busy.approvals = true
  try {
    const data = await http<unknown>('/approvals?status=pending&limit=' + LIST_LIMIT)
    approvals.value = listOf(data, ['approvals', 'items', 'list'])
      .map(normalizeApproval)
      .filter((a): a is Approval => Boolean(a))
  } catch (e) {
    const err = toApiError(e)
    if (err.status === 401) goPairing('登录状态已过期')
    else if (err.status !== 403) pushToast('warn', '待审批加载失败：' + messageOf(err))
  } finally {
    busy.approvals = false
  }
}

/* ---------------- 事件写入本地状态 ---------------- */

function upsertMessage(m: Message): void {
  if (!m.id) return
  const i = messages.value.findIndex((x) => x.id === m.id)
  if (i >= 0) messages.value[i] = { ...messages.value[i], ...m }
  else messages.value.push(m)
  void scrollMessages()
}

function markMessageStatus(id: string, status: string): void {
  if (!id) return
  const m = messages.value.find((x) => x.id === id)
  if (m) m.status = status
}

function appendDelta(id: string, delta: string, conversationId: string): void {
  const existing = messages.value.find((x) => x.id === id)
  if (existing) {
    const merged = existing.content + delta
    existing.content =
      merged.length > MAX_CONTENT ? merged.slice(merged.length - MAX_CONTENT) : merged
    existing.status = 'streaming'
  } else {
    messages.value.push({
      id,
      role: 'assistant',
      content: delta.slice(0, MAX_CONTENT),
      status: 'streaming',
      createdAt: Date.now(),
      ...(conversationId ? {} : {})
    })
  }
  void scrollMessages()
}

const RUN_CONTROL_LABELS: Record<string, string> = {
  pause_requested: '正在等待安全暂停点',
  paused: '已暂停',
  resume_requested: '正在恢复',
  stop_requested: '正在停止'
}

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: '等待执行',
  running: '执行中',
  waiting_child: '等待子任务',
  done: '已完成',
  completed: '已完成',
  stopped: '已停止',
  error: '出错',
  max_steps: '达到步数上限',
  transferred: '已移交',
  interrupted: '执行中断',
  cancelled: '已取消'
}

function runLabel(run: Run): string {
  const base = RUN_STATUS_LABELS[run.status] || run.status || '未知'
  const ctrl = run.control ? RUN_CONTROL_LABELS[run.control] : ''
  return ctrl ? `${base} · ${ctrl}` : base
}

function isRunActive(run: Run): boolean {
  return ['queued', 'running', 'waiting_child'].includes(run.status)
}

function applyRunEvent(
  type: string,
  payload: Record<string, unknown>,
  conversationId: string
): void {
  const id = text(field(payload, ['run_id', 'runId', 'id']), 64)
  if (!id) {
    void loadRuns()
    return
  }
  const incoming = normalizeRun({
    ...payload,
    id,
    conversation_id: conversationId || payload.conversation_id
  })
  if (!incoming) return
  const i = runs.value.findIndex((r) => r.id === id)
  if (i >= 0) {
    const prev = runs.value[i]
    const next: Run = {
      ...prev,
      ...incoming,
      status: incoming.status || prev.status,
      goal: incoming.goal || prev.goal,
      control: incoming.control ?? prev.control,
      transferToRunId: incoming.transferToRunId || prev.transferToRunId
    }
    runs.value[i] = next
  } else {
    runs.value.unshift(incoming)
  }
  if (type.includes('control')) void loadRuns()
}

function applyPlanEvent(
  type: string,
  payload: Record<string, unknown>,
  conversationId: string
): void {
  const planId = text(field(payload, ['plan_id', 'planId', 'id']), 64)
  if (!planId) return
  const status = text(
    field(payload, ['status'], type.endsWith('confirmed') ? 'confirmed' : 'draft'),
    24
  )
  if (status !== 'draft') {
    plans.value = plans.value.filter((plan) => plan.planId !== planId)
    return
  }
  const tasks = Array.isArray(payload.tasks)
    ? payload.tasks.map((task) => {
        const item = task as Record<string, unknown>
        return {
          key: text(field(item, ['key']), 40),
          goal: text(field(item, ['goal']), 2000),
          deps: Array.isArray(item.deps) ? item.deps.map(String) : []
        }
      })
    : []
  const plan: ClusterPlan = {
    planId,
    parentRunId: text(field(payload, ['parent_run_id', 'parentRunId']), 64),
    conversationId,
    status,
    etag: text(field(payload, ['etag']), 128),
    graphId: text(field(payload, ['graph_id', 'graphId']), 64) || null,
    tasks
  }
  const index = plans.value.findIndex((item) => item.planId === planId)
  if (index >= 0) plans.value[index] = plan
  else plans.value.unshift(plan)
}

function applyApprovalEvent(type: string, payload: Record<string, unknown>): void {
  const id = text(field(payload, ['approval_id', 'approvalId', 'id']), 64)
  if (type.startsWith('approval.created')) {
    const a = normalizeApproval({ ...payload, id })
    if (a) {
      if (!approvals.value.some((x) => x.id === a.id)) approvals.value.unshift(a)
      pushToast('info', `桌面 Agent 请求执行 ${a.tool}，等待审批`)
    }
    return
  }
  if (type.startsWith('approval.decided') || type.startsWith('approval.resolved')) {
    const status = text(field(payload, ['status', 'decision'], ''), 16).toLowerCase()
    if (id && status && ['approved', 'rejected'].includes(status)) {
      pushToast(
        status === 'approved' ? 'ok' : 'warn',
        `审批已被${status === 'approved' ? '批准' : '拒绝'}${idDecidedByMine(id) ? '' : '（其他设备）'}`
      )
    }
    void loadApprovals()
    return
  }
  if (
    type.startsWith('approval.expired') ||
    type.startsWith('approval.cancelled') ||
    type.startsWith('approval.superseded')
  ) {
    void loadApprovals()
    return
  }
  void loadApprovals()
}

function idDecidedByMine(id: string): boolean {
  return Boolean(id && respondedApprovals.has(id))
}
const respondedApprovals = new Set<string>()

/* ---------------- 操作动作 ---------------- */

const draft = ref('')
const goal = ref('')
const permission = ref<'autonomous' | 'readonly'>('readonly')
const cluster = ref(false)
const messagesEl = ref<HTMLElement | null>(null)

async function scrollMessages(): Promise<void> {
  await nextTick()
  const el = messagesEl.value
  if (el) el.scrollTop = el.scrollHeight
}

function setPermission(value: 'autonomous' | 'readonly'): void {
  permission.value = value
  if (value === 'readonly') cluster.value = false
}

async function sendChat(): Promise<void> {
  const content = draft.value.trim()
  if (!content) return
  if (!capability.value.operator) {
    pushToast('warn', '当前设备角色为只读，无法发送消息')
    return
  }
  if (content.length > MAX_CONTENT) {
    pushToast('warn', `消息超出 ${MAX_CONTENT} 字符上限，请精简`)
    return
  }
  if (!activeConversationId.value && conversations.value.length) {
    pushToast('warn', '请先选择一个会话')
    return
  }
  busy.send = true
  const rid = sendCommand(
    'chat.message.send',
    { content, mode: 'chat' },
    activeConversationId.value || null
  )
  if (!rid) {
    const queuedId = enqueueOfflineCommand(
      'chat.message.send',
      { content, mode: 'chat' },
      activeConversationId.value || null
    )
    messages.value.push({
      id: queuedId,
      role: 'user',
      content,
      status: 'queued',
      createdAt: Date.now()
    })
    draft.value = ''
    busy.send = false
    pushToast('ok', '已加入离线队列，连接恢复后自动发送')
    if (conn.value !== 'connecting') connectSocket()
    return
  }
  messages.value.push({ id: rid, role: 'user', content, status: 'sending', createdAt: Date.now() })
  draft.value = ''
  await scrollMessages()
  window.setTimeout(() => {
    busy.send = false
  }, 300)
}

function stopStreaming(): void {
  const streaming = messages.value.find((m) => m.status === 'streaming')
  if (!streaming) {
    pushToast('info', '当前没有正在生成的回复')
    return
  }
  const rid = sendCommand(
    'chat.message.stop',
    { message_id: streaming.id, msgId: streaming.id },
    activeConversationId.value || null
  )
  if (!rid) pushToast('warn', '实时通道未连接')
}

async function startRun(): Promise<void> {
  const g = goal.value.trim()
  if (!g) {
    pushToast('warn', '请先填写任务目标')
    return
  }
  if (!capability.value.operator) {
    pushToast('warn', '当前设备角色为只读，无法启动任务')
    return
  }
  if (permission.value === 'readonly') cluster.value = false
  if (permission.value === 'autonomous') {
    const ok = await confirmAction({
      title: '以自主权限启动任务',
      message:
        'autonomous 允许 Agent 在授权目录内自主调用工具（含写操作）。请确认目标描述清晰、范围可控。',
      confirmText: '确认启动',
      danger: true
    })
    if (!ok) return
  }
  const rid = sendCommand(
    'agent.run.start',
    {
      goal: g,
      permission: permission.value,
      cluster: cluster.value,
      conversation_id: activeConversationId.value || null
    },
    activeConversationId.value || null
  )
  if (!rid) {
    pushToast('warn', '实时通道未连接，正在重连')
    connectSocket()
    return
  }
  pushToast('info', '任务启动请求已发送')
  goal.value = ''
  tab.value = 'runs'
  void loadRuns()
}

async function decidePlan(plan: ClusterPlan, confirm: boolean): Promise<void> {
  if (!capability.value.operator) {
    pushToast('warn', '当前角色不能确认集群计划')
    return
  }
  const ok = await confirmAction({
    title: confirm ? '确认集群计划' : '拒绝集群计划',
    message: confirm ? '确认后将原子创建子任务并开始排队执行。' : '拒绝后不会创建任何子任务。',
    confirmText: confirm ? '确认执行' : '确认拒绝',
    danger: confirm
  })
  if (!ok) return
  const rid = sendCommand(
    confirm ? 'agent.plan.confirm' : 'agent.plan.reject',
    { plan_id: plan.planId, planId: plan.planId, etag: plan.etag },
    plan.conversationId || null
  )
  if (!rid) {
    pushToast('warn', '实时通道未连接')
    return
  }
  plans.value = plans.value.filter((item) => item.planId !== plan.planId)
  void loadRuns()
}

async function controlRun(run: Run, action: 'pause' | 'resume' | 'stop'): Promise<void> {
  if (!capability.value.operator) {
    pushToast('warn', '当前设备角色为只读，无法控制任务')
    return
  }
  const copy = {
    pause: {
      title: '请求暂停任务',
      message: '暂停只在安全检查点生效，不会中断正在执行的模型调用或工具。'
    },
    resume: { title: '恢复任务', message: '从当前安全等待点继续同一个任务，不会重置步数。' },
    stop: {
      title: '请求停止任务',
      message: '停止是协作式的：模型请求会被中止，已在执行的工具需返回后才收敛。'
    }
  }[action]
  if (
    action !== 'resume' &&
    !(await confirmAction({ ...copy, confirmText: '确认', danger: action === 'stop' }))
  )
    return
  const rid = sendCommand(
    `agent.run.${action}`,
    { run_id: run.id, runId: run.id },
    run.conversationId || null
  )
  if (!rid) {
    pushToast('warn', '实时通道未连接')
    connectSocket()
    return
  }
  const map = { pause: 'pause_requested', resume: 'resume_requested', stop: 'stop_requested' }
  run.control = map[action]
  pushToast('info', '控制请求已发送')
}

async function recoverRun(run: Run, mode: 'continue' | 'retry'): Promise<void> {
  if (!capability.value.operator) {
    pushToast('warn', '当前设备角色为只读，无法恢复任务')
    return
  }
  const ok = await confirmAction({
    title: mode === 'continue' ? '核对后续跑' : '关联新任务重试',
    message:
      mode === 'continue'
        ? '仅从安全边界继续同一个任务，已完成的工具不会重放。'
        : '保留原中断记录并创建关联新任务；未知副作用不会自动重放。',
    confirmText: '确认',
    danger: mode === 'retry'
  })
  if (!ok) return
  const rid = sendCommand(
    'agent.run.retry',
    { run_id: run.id, runId: run.id, mode },
    run.conversationId || null
  )
  if (!rid) {
    pushToast('warn', '实时通道未连接')
    connectSocket()
    return
  }
  pushToast('info', '恢复请求已发送')
}

async function respondApproval(
  approval: Approval,
  decision: 'approved' | 'rejected'
): Promise<void> {
  if (!capability.value.approver) {
    pushToast('warn', '当前设备角色没有审批权限')
    return
  }
  if (approval.expiresAt && approval.expiresAt <= Date.now()) {
    pushToast('warn', '该审批已过期，无法提交决定')
    void loadApprovals()
    return
  }
  const ok = await confirmAction({
    title: decision === 'approved' ? '批准执行该工具' : '拒绝该工具调用',
    message:
      `工具：${approval.tool}\n风险：${approval.risk || '未标注'}\n参数摘要：${approval.argsSummary || '（无）'}\n` +
      (decision === 'approved'
        ? '批准后桌面 Agent 将在执行前再次校验参数摘要与权限，不保证立即完成。'
        : '拒绝结果会作为工具失败返回给 Agent 循环。'),
    confirmText: decision === 'approved' ? '确认批准' : '确认拒绝',
    danger: decision === 'approved'
  })
  if (!ok) return
  const rid = sendCommand(
    'approval.respond',
    {
      approval_id: approval.id,
      approvalId: approval.id,
      decision,
      expected_version: approval.version
    },
    approval.conversationId || null
  )
  if (!rid) {
    pushToast('warn', '实时通道未连接')
    connectSocket()
    return
  }
  respondedApprovals.add(approval.id)
  approvals.value = approvals.value.filter((a) => a.id !== approval.id)
  pushToast('info', '审批决定已提交')
}

/* ---------------- 危险操作确认（页面内实现，不依赖 window.confirm） ---------------- */

const confirmState = reactive<{
  open: boolean
  title: string
  message: string
  confirmText: string
  danger: boolean
  _resolve: ((_v: boolean) => void) | null
}>({ open: false, title: '', message: '', confirmText: '确认', danger: false, _resolve: null })

function confirmAction(opts: {
  title: string
  message: string
  confirmText?: string
  danger?: boolean
}): Promise<boolean> {
  if (confirmState._resolve) {
    confirmState._resolve(false)
    confirmState._resolve = null
  }
  confirmState.open = true
  confirmState.title = opts.title
  confirmState.message = opts.message
  confirmState.confirmText = opts.confirmText || '确认'
  confirmState.danger = Boolean(opts.danger)
  return new Promise<boolean>((resolve) => {
    confirmState._resolve = resolve
  })
}

function resolveConfirm(value: boolean): void {
  const r = confirmState._resolve
  confirmState.open = false
  confirmState._resolve = null
  if (r) r(value)
}

/* ---------------- 派生展示 ---------------- */

const connLabel = computed(() => {
  const base =
    insecure.value && conn.value === 'online'
      ? '已连接（非加密）'
      : { offline: '未连接', connecting: '连接中', online: '已连接', retrying: '重连中' }[
          conn.value
        ]
  return offlineQueue.value.length ? `${base} · 待同步 ${offlineQueue.value.length}` : base
})
const connClass = computed(() => 'dot dot-' + conn.value)
const pendingCount = computed(() => approvals.value.length)
const activeRuns = computed(() => runs.value.filter(isRunActive))
const canSend = computed(
  () => capability.value.operator && draft.value.trim().length > 0 && !busy.send
)
const roleHint = computed(() => {
  const c = capability.value
  const parts: string[] = []
  if (c.viewer) parts.push('查看')
  if (c.operator) parts.push('执行')
  if (c.approver) parts.push('审批')
  return parts.join(' / ') || '未授予任何权限'
})

function msgClass(m: Message): string {
  return (
    'msg msg-' +
    (m.role === 'user' ? 'user' : 'agent') +
    (m.status === 'streaming' ? ' is-streaming' : '')
  )
}

function riskClass(risk?: string): string {
  const r = (risk || '').toLowerCase()
  if (r.includes('high') || r.includes('critical') || r.includes('高')) return 'badge badge-bad'
  if (r.includes('medium') || r.includes('中')) return 'badge badge-warn'
  return 'badge badge-ok'
}

function switchTab(key: TabKey): void {
  tab.value = key
  if (key === 'runs' && runs.value.length === 0) void loadRuns()
  if (key === 'approvals' && approvals.value.length === 0) void loadApprovals()
  if (key === 'chat' && conversations.value.length === 0) void loadConversations()
  if (key === 'device') {
    void loadSelf()
    void refreshAuthStatus()
  }
}

/* ---------------- 生命周期 ---------------- */

onMounted(() => {
  void boot()
})

onBeforeUnmount(() => {
  stopWatchdog()
  failAllPending('页面已卸载')
  closeSocket()
})
</script>

<template>
  <div class="rm-root" data-testid="remote-mobile" :data-phase="phase">
    <!-- 顶部：连接状态 -->
    <header class="rm-header">
      <div class="rm-title">
        <span class="brand-dot" aria-hidden="true"></span>
        <span>Mini Agent 远程控制</span>
      </div>
      <div v-if="phase === 'app'" class="rm-status" data-testid="remote-connection">
        <span :class="connClass" aria-hidden="true"></span>
        <span>{{ connLabel }}</span>
        <span class="rm-role">{{ capability.role }}</span>
      </div>
    </header>

    <p v-if="insecure" class="banner banner-warn">
      当前为非加密的局域网 HTTP/WS
      连接，消息与凭证可能被同网络攻击者窃取。仅在受信任网络下临时使用。
    </p>

    <main class="rm-main">
      <!-- 启动中 -->
      <section v-if="phase === 'boot'" class="pane pane-center" data-testid="remote-phase-boot">
        <p class="muted">正在检查登录状态…</p>
      </section>

      <!-- 配对 -->
      <section v-else-if="phase === 'pairing'" class="pane" data-testid="remote-phase-pairing">
        <h2 class="pane-h">设备配对</h2>

        <div v-if="!pair.ticket" class="card">
          <p class="muted">
            还没有拿到配对链接。请在桌面端 Mini Agent 打开「远程控制」，用手机扫描二维码或访问形如
            <code>https://桌面IP:端口/pair#ticket=…</code> 的链接。
          </p>
          <label class="field">
            <span>也可以手动粘贴配对码（ticket）</span>
            <input
              v-model="pair.ticket"
              data-testid="remote-pair-ticket"
              type="text"
              inputmode="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="ticket"
              maxlength="128"
            />
          </label>
        </div>

        <div v-else class="card">
          <p class="ticket-line">
            已读取配对码
            <span class="mono">{{ pair.ticket.slice(0, 6) }}…（已自动从地址栏清除）</span>
          </p>

          <label class="field">
            <span>设备名称</span>
            <input
              v-model="pair.name"
              data-testid="remote-pair-name"
              type="text"
              maxlength="40"
              autocomplete="off"
              :disabled="pair.status === 'submitting'"
            />
          </label>

          <p class="muted small">
            扫码即确认连接，当前及后续创建的会话将自动授权，无需核对码或逐项勾选。
          </p>

          <ul class="security-notes">
            <li>配对码一次性使用，180 秒过期；本页不会把它写入 URL、日志或存储。</li>
            <li>
              设备凭证 device secret 只保存在 sessionStorage：关闭标签页即失效，不写
              localStorage/IndexedDB。
            </li>
            <li>浏览器本地存储不具备密钥库强度，请勿在他人手机或公共设备上配对。</li>
          </ul>

          <div
            v-if="pair.status === 'idle' || pair.status === 'error' || pair.status === 'expired'"
            class="row"
          >
            <button
              class="btn-primary"
              data-testid="remote-pair-submit"
              type="button"
              :disabled="pair.status === 'submitting'"
              @click="startPairing"
            >
              立即连接
            </button>
          </div>
          <div v-else-if="pair.status === 'submitting'" class="row">
            <span class="spinner" aria-hidden="true"></span
            ><span class="muted">正在连接桌面端…</span>
          </div>

          <p v-if="pair.error" class="banner banner-bad">{{ pair.error }}</p>
        </div>
      </section>

      <!-- 主界面：会话 / 任务 / 审批 / 设备 -->
      <section v-else class="pane pane-fill" data-testid="remote-phase-app">
        <nav class="tabs" role="tablist">
          <button
            v-for="t in TABS"
            :key="t.key"
            class="tab"
            :data-testid="'remote-tab-' + t.key"
            role="tab"
            type="button"
            :aria-selected="tab === t.key"
            :class="{ active: tab === t.key }"
            @click="switchTab(t.key)"
          >
            <span>{{ t.label }}</span>
            <span v-if="t.key === 'approvals' && pendingCount" class="pill">{{
              pendingCount
            }}</span>
            <span v-else-if="t.key === 'runs' && activeRuns.length" class="pill pill-soft">{{
              activeRuns.length
            }}</span>
          </button>
        </nav>

        <!-- 会话 -->
        <div v-if="tab === 'chat'" class="stack">
          <div class="conv-bar">
            <label class="field field-inline">
              <span class="sr-only">会话</span>
              <select
                v-model="activeConversationId"
                data-testid="remote-conversation"
                @change="selectConversation(activeConversationId)"
              >
                <option v-for="c in conversations" :key="c.id" :value="c.id">{{ c.title }}</option>
                <option v-if="!conversations.length" value="">（无授权会话）</option>
              </select>
            </label>
            <button
              class="btn-ghost"
              data-testid="remote-messages-refresh"
              type="button"
              :disabled="busy.messages"
              @click="loadMessages"
            >
              刷新
            </button>
          </div>

          <div ref="messagesEl" class="messages scroll" data-testid="remote-messages">
            <p v-if="busy.messages" class="muted center">加载中…</p>
            <p v-else-if="!messages.length" class="muted center">这个会话还没有消息。</p>
            <article
              v-for="m in messages"
              :key="m.id"
              :data-testid="'remote-message-' + m.id"
              :data-status="m.status"
              :class="msgClass(m)"
            >
              <header class="msg-h">
                <span>{{ m.role === 'user' ? '我' : 'Agent' }}</span>
                <span v-if="m.status === 'streaming'" class="tag">生成中</span>
                <span v-else-if="m.status === 'error'" class="tag tag-bad">出错</span>
                <span v-else-if="m.status === 'sending' || m.status === 'sent'" class="tag"
                  >已发送</span
                >
                <span v-else-if="m.status === 'queued'" class="tag">待同步</span>
              </header>
              <div class="msg-b">{{ m.content }}</div>
            </article>
          </div>

          <footer class="composer">
            <textarea
              v-model="draft"
              data-testid="remote-chat-input"
              rows="2"
              maxlength="16000"
              :disabled="!capability.operator"
              :placeholder="
                capability.operator ? '发消息给 Agent…' : '当前角色为只读，不能发送消息'
              "
              @keydown.enter.exact.prevent="sendChat"
            ></textarea>
            <div class="row row-end">
              <span class="muted small">{{ draft.length }}/16000</span>
              <button class="btn-ghost" type="button" @click="stopStreaming">停止</button>
              <button
                class="btn-primary"
                data-testid="remote-chat-send"
                type="button"
                :disabled="!canSend"
                @click="sendChat"
              >
                发送
              </button>
            </div>
          </footer>
        </div>

        <!-- 任务 -->
        <div v-else-if="tab === 'runs'" class="stack">
          <div class="card">
            <label class="field">
              <span>任务目标</span>
              <textarea
                v-model="goal"
                rows="3"
                maxlength="2000"
                :disabled="!capability.operator"
                placeholder="例如：整理本周会议纪要并生成待办清单"
              ></textarea>
            </label>
            <div class="row row-between">
              <div class="seg" role="group" aria-label="权限">
                <button
                  type="button"
                  :class="{ active: permission === 'readonly' }"
                  @click="setPermission('readonly')"
                >
                  只读
                </button>
                <button
                  type="button"
                  :class="{ active: permission === 'autonomous' }"
                  @click="setPermission('autonomous')"
                >
                  自主
                </button>
              </div>
              <label class="row row-end" style="gap: 8px">
                <input
                  v-model="cluster"
                  type="checkbox"
                  :disabled="permission === 'readonly' || !capability.operator"
                  data-testid="remote-cluster-toggle"
                />
                <span>Agent 集群</span>
              </label>
              <button
                class="btn-primary"
                type="button"
                :disabled="!capability.operator || !goal.trim()"
                @click="startRun"
              >
                启动任务
              </button>
            </div>
            <p class="muted small">
              {{
                permission === 'autonomous'
                  ? 'autonomous：Agent 可在授权目录内自主调用工具，含写操作，会二次确认。'
                  : 'readonly：Agent 只能读取与分析，不写入、不执行副作用。'
              }}
              {{ cluster ? ' 集群已开启：模型先提交计划，确认后才执行子任务。' : '' }}
            </p>
            <p v-if="!capability.operator" class="muted small">
              当前角色 {{ capability.role }}（{{ roleHint }}），不能启动任务。
            </p>
          </div>

          <div
            v-for="plan in plans"
            :key="plan.planId"
            class="card"
            data-testid="remote-cluster-plan"
          >
            <strong>Agent 集群计划待确认</strong>
            <p class="muted small">{{ plan.tasks.length }} 个节点，确认前不会执行。</p>
            <ol class="stack">
              <li v-for="task in plan.tasks" :key="task.key" class="card">
                <strong>{{ task.key }}</strong>
                <p class="small">{{ task.goal }}</p>
                <p v-if="task.deps?.length" class="muted small">依赖：{{ task.deps.join('、') }}</p>
              </li>
            </ol>
            <div class="row row-end">
              <button class="btn-ghost" type="button" @click="decidePlan(plan, false)">拒绝</button>
              <button class="btn-primary" type="button" @click="decidePlan(plan, true)">
                确认并执行
              </button>
            </div>
          </div>

          <div class="row row-between">
            <h3 class="sub-h">任务列表</h3>
            <button class="btn-ghost" type="button" :disabled="busy.runs" @click="loadRuns">
              刷新
            </button>
          </div>
          <p v-if="busy.runs && !runs.length" class="muted center">加载中…</p>
          <p v-else-if="!runs.length" class="muted center">暂无任务。</p>
          <article v-for="r in runs" :id="'run-' + r.id" :key="r.id" class="card card-run">
            <header class="row row-between">
              <strong class="run-goal">{{ r.goal }}</strong>
              <span class="badge badge-info">{{ runLabel(r) }}</span>
            </header>
            <p class="muted small mono">{{ r.id.slice(0, 8) }} · {{ fmtTime(r.updatedAt) }}</p>
            <div class="row row-end">
              <template v-if="isRunActive(r)">
                <button
                  class="btn-ghost"
                  type="button"
                  :disabled="
                    !capability.operator ||
                    r.control === 'pause_requested' ||
                    r.control === 'paused'
                  "
                  @click="controlRun(r, 'pause')"
                >
                  暂停
                </button>
                <button
                  class="btn-ghost"
                  type="button"
                  :disabled="!capability.operator || r.control !== 'paused'"
                  @click="controlRun(r, 'resume')"
                >
                  继续
                </button>
                <button
                  class="btn-danger"
                  type="button"
                  :disabled="!capability.operator || r.control === 'stop_requested'"
                  @click="controlRun(r, 'stop')"
                >
                  停止
                </button>
              </template>
              <template v-else-if="r.status === 'interrupted'">
                <button
                  class="btn-ghost"
                  type="button"
                  :disabled="!capability.operator"
                  @click="recoverRun(r, 'continue')"
                >
                  核对后续跑
                </button>
                <button
                  class="btn-ghost"
                  type="button"
                  :disabled="!capability.operator"
                  @click="recoverRun(r, 'retry')"
                >
                  关联重试
                </button>
              </template>
              <a
                v-else-if="r.transferToRunId && runs.some((run) => run.id === r.transferToRunId)"
                :href="'#run-' + r.transferToRunId"
                >查看接手任务</a
              >
              <span v-else class="muted small">已结束</span>
            </div>
          </article>
        </div>

        <!-- 审批 -->
        <div v-else-if="tab === 'approvals'" class="stack">
          <div class="row row-between">
            <h3 class="sub-h">待审批（{{ pendingCount }}）</h3>
            <button
              class="btn-ghost"
              type="button"
              :disabled="busy.approvals"
              @click="loadApprovals"
            >
              刷新
            </button>
          </div>
          <p v-if="!capability.approver" class="banner banner-info">
            当前角色 {{ capability.role }} 没有审批权限，不能查看或处理待审批列表。
          </p>
          <p v-if="busy.approvals && !approvals.length" class="muted center">加载中…</p>
          <p v-else-if="!approvals.length" class="muted center">没有待审批的工具调用。</p>
          <article v-for="a in approvals" :key="a.id" class="card">
            <header class="row row-between">
              <strong>{{ a.tool }}</strong>
              <span :class="riskClass(a.risk)">{{ a.risk || 'risk?' }}</span>
            </header>
            <p v-if="a.argsSummary" class="args">{{ a.argsSummary }}</p>
            <p class="muted small">
              Run {{ a.runId ? a.runId.slice(0, 8) : '—' }} · 申请 {{ fmtTime(a.createdAt) }} ·
              {{ fmtCountdown(a.expiresAt) }} · v{{ a.version }}
            </p>
            <div class="row row-end">
              <button
                class="btn-ghost"
                type="button"
                :disabled="!capability.approver"
                @click="respondApproval(a, 'rejected')"
              >
                拒绝
              </button>
              <button
                class="btn-primary"
                type="button"
                :disabled="!capability.approver"
                @click="respondApproval(a, 'approved')"
              >
                批准
              </button>
            </div>
          </article>
        </div>

        <!-- 设备 -->
        <div v-else class="stack" data-testid="remote-device-panel">
          <div class="card">
            <h3 class="sub-h">当前设备</h3>
            <dl class="kv">
              <dt>名称</dt>
              <dd>{{ device.name || pair.name || '本机' }}</dd>
              <dt>角色</dt>
              <dd>{{ capability.role }}</dd>
              <dt>能力</dt>
              <dd>{{ roleHint }}</dd>
              <dt>设备 ID</dt>
              <dd class="mono">{{ device.deviceId || credentials.deviceId || '—' }}</dd>
              <dt>状态</dt>
              <dd>{{ device.status || (serverAuth.authenticated ? 'active' : '未知') }}</dd>
              <dt>最近活动</dt>
              <dd>{{ fmtTime(Number(device.lastSeenAt) || 0) }}</dd>
              <dt>事件游标</dt>
              <dd class="mono">
                seq {{ lastSeq }} · {{ streamEpoch ? streamEpoch.slice(0, 8) : '—' }}
              </dd>
              <dt>协议通道</dt>
              <dd data-testid="remote-transport">{{ insecure ? 'ws（非加密）' : 'wss' }}</dd>
            </dl>
          </div>

          <div class="card">
            <h3 class="sub-h">凭证与安全</h3>
            <ul class="security-notes">
              <li>
                device secret 仅存 sessionStorage，关闭标签页自动失效；刷新页面可自动恢复会话。
              </li>
              <li>
                桌面服务使用短期 HttpOnly Cookie 鉴权，WebSocket URL 与命令帧均不携带长期凭证。
              </li>
              <li>「退出登录」只撤销当前浏览器会话；移除设备需在桌面端执行。</li>
            </ul>
            <div class="row row-end">
              <button class="btn-ghost" type="button" @click="resumeSync">重新同步</button>
              <button class="btn-danger" type="button" :disabled="busy.logout" @click="logout">
                {{ busy.logout ? '退出中…' : '退出登录' }}
              </button>
            </div>
            <p v-if="insecure" class="banner banner-warn">非加密模式下请勿发送任何敏感内容。</p>
          </div>
        </div>
      </section>
    </main>

    <!-- 提示条 -->
    <div class="toasts" aria-live="polite">
      <div v-for="t in toasts" :key="t.id" class="toast" :class="'toast-' + t.tone">
        {{ t.message }}
      </div>
    </div>

    <!-- 确认对话框 -->
    <div
      v-if="confirmState.open"
      class="overlay"
      data-testid="remote-confirm-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="confirmState.title"
    >
      <div class="dialog">
        <h3>{{ confirmState.title }}</h3>
        <p class="dialog-body">{{ confirmState.message }}</p>
        <div class="row row-end">
          <button class="btn-ghost" type="button" @click="resolveConfirm(false)">取消</button>
          <button
            :class="confirmState.danger ? 'btn-danger' : 'btn-primary'"
            type="button"
            @click="resolveConfirm(true)"
          >
            {{ confirmState.confirmText }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>
