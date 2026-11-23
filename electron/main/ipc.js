const { app, clipboard, dialog, ipcMain, shell } = require('electron')
const fs = require('fs')
const dbm = require('../store/db')
const repos = require('../store/repos')
const { encryptSecret, decryptSecret } = require('../store/keys')
const gateway = require('./gateway/index')
const agent = require('./agent/index')
const rag = require('./rag/index')
const localModels = require('./rag/local-models')
const faissIndex = require('./rag/faiss-index')
const { getScheduler } = require('./probe-scheduler')
const { getUpdater } = require('./updater')
const { probeKey } = require('./gateway/probe')
const { captureRegion } = require('./sys/capture')
const { captureSelectedText } = require('./sys/selection')
const exporter = require('./exporter')
const windows = require('./windows')
const { broadcast } = require('./notify')
const scheduler = require('./gateway/scheduler')
const sessionsApi = require('./agent/sessions')
const { getHub } = require('./events/hub')
const { parseHooks, runHooks, STAGES, ACTIONS } = require('./events/hooks')
const runtimeLog = require('./runtime-log')

function safeParse(s, d) {
  try {
    return s ? JSON.parse(s) : d
  } catch {
    return d
  }
}

function providerOut(p) {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.base_url,
    rotationStrategy: p.rotation_strategy,
    probeIntervalMin: p.probe_interval_min,
    probeModel: p.probe_model,
    enabled: p.enabled !== 0,
    models: safeParse(p.models, []) || []
  }
}

async function probeOne(db, keyId) {
  const k = repos.getKeyWithSecret(db, keyId)
  if (!k) throw new Error('Key 不存在')
  const p = repos.getProvider(db, k.provider_id)
  if (!p) throw new Error('供应商不存在')
  const models = safeParse(p.models, []) || []
  const model = p.probe_model || (models[0] && models[0].id) || 'gpt-3.5-turbo'
  const r = await probeKey({
    baseUrl: p.base_url,
    apiKey: await decryptSecret(k.secret_enc),
    model
  })
  // 400/404 on the probe call means auth passed but model/params are wrong — key is alive.
  const mapped = r.kind === 'bad_request' ? 'ok' : r.kind
  repos.updateKeyStatus(
    db,
    keyId,
    scheduler.applyKeyResult({ status: k.status, rateCount: k.rate_count }, mapped, Date.now(), {
      lastError: r.detail
    })
  )
  repos.logKeyEvent(db, {
    apiKeyId: keyId,
    kind: 'probe',
    result: mapped,
    detail: `${r.status || ''} ${r.latencyMs}ms ${r.detail}`.trim()
  })
  broadcast('keys:event', { providerId: k.provider_id })
  return { keyId, ...r, kind: mapped }
}

async function probeAllForProvider(providerId) {
  const db = dbm.get()
  const keys = repos.listKeys(db, providerId)
  const results = []
  for (const k of keys) {
    try {
      results.push(await probeOne(db, k.id))
    } catch (e) {
      results.push({
        keyId: k.id,
        ok: false,
        kind: 'error',
        detail: String((e && e.message) || e)
      })
    }
  }
  return results
}

// 模型包下载状态（内存）：下载中防重复触发 + 进度节流。
const downloadStates = new Map()

function startModelDownload(id) {
  const pkg = localModels.getPackage(id)
  if (!pkg) throw new Error(`未知模型包: ${id}`)
  if (downloadStates.has(id)) return { started: false, reason: 'downloading' }
  const root = rag.modelsRootFor()
  downloadStates.set(id, { status: 'downloading' })
  let lastSent = 0
  localModels
    .downloadPackage(root, pkg, {
      onProgress: (p) => {
        const nowMs = Date.now()
        const finished = p.done >= p.total
        if (!finished && nowMs - lastSent < 150) return
        lastSent = nowMs
        broadcast('models:progress', { id, ...p, status: 'downloading' })
      }
    })
    .then(() => {
      downloadStates.delete(id)
      broadcast('models:progress', { id, done: true, status: 'done' })
    })
    .catch((e) => {
      downloadStates.delete(id)
      broadcast('models:progress', {
        id,
        done: true,
        status: 'error',
        error: String((e && e.message) || e).slice(0, 200)
      })
    })
  return { started: true }
}

function registerIpc(ctx) {
  const h = (ch, fn) => ipcMain.handle(ch, async (_e, ...args) => fn(...args))

  // settings
  h('settings:get', (k) => repos.getSetting(dbm.get(), k))
  h('settings:set', (k, v) => {
    repos.setSetting(dbm.get(), k, v)
    return true
  })
  h('settings:all', () => repos.getAllSettings(dbm.get()))

  // providers & keys
  h('providers:list', () => {
    const db = dbm.get()
    return repos
      .listProviders(db)
      .map((p) => ({ ...providerOut(p), keys: repos.listKeys(db, p.id) }))
  })
  h('providers:save', (p) => {
    const id = repos.saveProvider(dbm.get(), p)
    const sched = getScheduler()
    if (sched) sched.reset(id)
    return id
  })
  h('providers:delete', (id) => {
    repos.softDeleteProvider(dbm.get(), id)
    return true
  })
  h('providers:fetchModels', async ({ id, baseUrl } = {}) => {
    const db = dbm.get()
    const p = repos.getProvider(db, id)
    if (!p) throw new Error('供应商不存在')
    const keys = repos.listAllKeysWithSecret(db).filter((k) => k.providerId === id)
    const key = keys.find((k) => ['ok', 'unknown'].includes(k.status)) || keys[0]
    if (!key) throw new Error('该供应商没有可用 Key')
    // baseUrl 来自编辑面板的 draft（可能尚未保存）；缺省回退到数据库值
    const base = String(baseUrl || p.base_url || '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(base)) throw new Error('Base URL 无效，需以 http(s):// 开头')
    const secret = await decryptSecret(key.secretEnc)
    const res = await fetch(base + '/models', {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) throw new Error(`获取模型列表失败: HTTP ${res.status}`)
    const j = await res.json()
    const ids = (j.data || []).map((m) => m.id).filter(Boolean)
    return ids.map((id2) => ({ id: id2, vision: false }))
  })
  h('keys:add', async ({ providerId, label, secret }) =>
    repos.addKey(dbm.get(), {
      providerId,
      label,
      secretEnc: await encryptSecret(String(secret || ''))
    })
  )
  h('keys:remove', (id) => {
    repos.softDeleteKey(dbm.get(), id)
    return true
  })
  h('keys:probe', async (keyId) => {
    const db = dbm.get()
    const k = repos.getKeyWithSecret(db, keyId)
    const r = await probeOne(db, keyId)
    const sched = getScheduler()
    if (sched && k) sched.reset(k.provider_id)
    return r
  })
  h('keys:probeAll', async (providerId) => {
    const r = await probeAllForProvider(providerId)
    const sched = getScheduler()
    if (sched) sched.reset(providerId)
    return r
  })
  h('keys:events', () => repos.listKeyEvents(dbm.get(), 100))

  // conversations
  h('conversations:list', () => repos.listConversations(dbm.get()))
  h('conversations:create', (opts) => repos.createConversation(dbm.get(), opts || {}))
  h('conversations:update', ({ id, patch }) => repos.updateConversation(dbm.get(), id, patch))
  h('conversations:delete', (id) => {
    repos.softDeleteConversation(dbm.get(), id)
    return true
  })
  h('conversations:search', (q) => repos.searchConversations(dbm.get(), q))
  h('conversations:messages', (id) => repos.listMessages(dbm.get(), id).map(gateway.msgOut))

  // projects（项目工作目录：会话分类 + Agent 命令执行目录）
  h('projects:list', () => {
    const db = dbm.get()
    return repos
      .listProjects(db)
      .map((p) => ({ ...p, sessionCount: repos.countProjectSessions(db, p.id) }))
  })
  h('projects:create', (o) => {
    const name = String((o && o.name) || '').trim()
    const dir = String((o && o.path) || '').trim()
    if (!name) throw new Error('项目名称不能为空')
    if (!dir) throw new Error('请选择项目工作目录')
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
      throw new Error('工作目录不存在或不是文件夹')
    const r = repos.createProject(dbm.get(), { name, path: dir })
    broadcast('projects:changed', {})
    return r
  })
  h('projects:update', ({ id, patch }) => {
    const db = dbm.get()
    if (patch && patch.path !== undefined) {
      const dir = String(patch.path || '').trim()
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
        throw new Error('工作目录不存在或不是文件夹')
      patch = { ...patch, path: dir }
    }
    const r = repos.updateProject(db, id, patch || {})
    if (!r) throw new Error('项目不存在')
    broadcast('projects:changed', {})
    return r
  })
  h('projects:delete', (id) => {
    repos.softDeleteProject(dbm.get(), id)
    broadcast('projects:changed', {})
    return true
  })

  // chat
  h('chat:send', (o) => gateway.sendChat(o))
  h('chat:stop', (msgId) => gateway.stopChat(msgId))
  h('chat:regenerate', (cid) => gateway.regenerate(cid))
  h('chat:editResend', (o) => gateway.editResend(o))
  h('chat:optimizePrompt', (o) => gateway.optimizePrompt(o))
  h('chat:messageDelete', (msgId) => {
    const m = repos.softDeleteMessage(dbm.get(), msgId)
    if (!m) throw new Error('消息不存在')
    broadcast('chat:event', {
      type: 'messageDeleted',
      conversationId: m.conversationId,
      msgId
    })
    return true
  })
  h('chat:export', async ({ cid, mode }) => {
    const db = dbm.get()
    const conv = repos.getConversation(db, cid)
    if (!conv) throw new Error('会话不存在')
    const rows = repos.listMessages(db, cid)
    let content
    let ext
    if (mode === 'json') {
      content = JSON.stringify({ conversation: conv, messages: rows }, null, 2)
      ext = 'json'
    } else {
      const roleName = (r) => (r === 'user' ? '用户' : r === 'assistant' ? '助手' : r)
      content =
        `# ${conv.title}\n\n` +
        rows
          .map(
            (m) =>
              `### ${roleName(m.role)}（${new Date(m.createdAt || m.created_at).toLocaleString('zh-CN')}）\n\n${m.content}`
          )
          .join('\n\n---\n\n')
      ext = 'md'
    }
    const dest = await dialog.showSaveDialog(windows.get('main'), {
      defaultPath: `${(conv.title || '会话').replace(/[\\/:*?"<>|]/g, '_')}.${ext}`,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (dest.canceled || !dest.filePath) return null
    fs.writeFileSync(dest.filePath, content, 'utf8')
    broadcast('app:notice', { level: 'success', message: `已导出到 ${dest.filePath}` })
    return dest.filePath
  })

  // knowledge base
  h('kb:list', () => {
    const db = dbm.get()
    return repos.listKbs(db).map((k) => ({ ...k, stats: repos.getKbStats(db, k.id) }))
  })
  h('kb:create', (o) => repos.createKb(dbm.get(), o))
  h('kb:update', ({ id, patch }) => repos.updateKb(dbm.get(), id, patch))
  h('kb:docs', (kbId) => repos.listDocs(dbm.get(), kbId))
  h('kb:import', ({ kbId, paths }) => {
    rag
      .importDocs({ kbId, paths })
      .catch((e) => broadcast('kb:progress', { kbId, error: String((e && e.message) || e) }))
    return { started: true }
  })
  h('kb:rebuild', ({ kbId }) => {
    rag
      .rebuildKb({ kbId })
      .catch((e) => broadcast('kb:progress', { kbId, error: String((e && e.message) || e) }))
    return { started: true }
  })
  h('kb:search', ({ kbId, query, k }) => {
    const db = dbm.get()
    const kb = repos.getKb(db, kbId)
    if (!kb) throw new Error('知识库不存在')
    return rag.searchKb(db, kb, query, { k: k || 5 })
  })
  h('kb:removeDoc', (id) => {
    repos.softDeleteDoc(dbm.get(), id)
    faissIndex.invalidateAll()
    return true
  })
  h('kb:delete', (id) => {
    faissIndex.invalidate(id)
    repos.softDeleteKb(dbm.get(), id)
    return true
  })

  // 本地嵌入模型包（一键下载/删除）
  h('models:list', () => {
    const root = rag.modelsRootFor()
    const downloading = new Set(downloadStates.keys())
    return localModels.listPackages(root).map((p) => ({
      ...p,
      downloading: downloading.has(p.id)
    }))
  })
  h('models:download', (id) => startModelDownload(id))
  h('models:remove', (id) => {
    const pkg = localModels.getPackage(id)
    if (!pkg) throw new Error(`未知模型包: ${id}`)
    if (downloadStates.has(id)) throw new Error('该模型包正在下载中')
    const root = rag.modelsRootFor()
    localModels.deletePackage(root, pkg)
    return true
  })

  // agent
  h('agent:run', ({ conversationId, goal, permission, cluster }) =>
    agent.startAgentRun({ conversationId, goal, permission, cluster })
  )
  h('agent:status', (id) => agent.getRunStatus(id))
  h('agent:result', ({ runId, maxChars }) => agent.getRunResult(runId, maxChars))
  h('agent:stop', (runId) => agent.stopRun(runId))
  h('agent:pause', (runId) => agent.pauseRun(runId))
  h('agent:resume', (runId) => agent.resumeRun(runId))
  h('agent:respond', (o) => agent.respondConfirm(o))
  h('agent:acceptance:decide', (o) => agent.decideAcceptance(o))
  h('agent:runs', () => repos.listRuns(dbm.get(), 50))
  h('agent:calls', (runId) => repos.getRunCalls(dbm.get(), runId))

  // 局域网远程控制：管理接口仅暴露给主窗口，手机只能走受限网络协议。
  const remoteManager = () => ctx.remote && ctx.remote()
  const requireRemote = () => {
    const remote = remoteManager()
    if (!remote) throw new Error('远程服务尚未初始化')
    return remote
  }
  h('remote:state', () => (remoteManager() ? remoteManager().getState() : { status: 'stopped' }))
  h('remote:start', (o) => requireRemote().start(o || {}))
  h('remote:stop', () => requireRemote().stop())
  h('remote:qrcode', () => requireRemote().qrCode())
  h('remote:devices:update', (o) => requireRemote().updateDevice(o.deviceId, o))
  h('remote:devices:revoke', (id) => requireRemote().revokeDevice(id))
  h('remote:audit:list', () => requireRemote().auditList())
  h('remote:certificate:export', () => requireRemote().exportCertificate())

  // sessions: 子会话状态
  h('sessions:status', (conversationId) => sessionsApi.getSessionStatus({ conversationId }))
  h('sessions:list', (o) => sessionsApi.listSessions(o || {}))
  h('sessions:result', (o) => sessionsApi.getSessionResult(o || {}))
  h('sessions:send', ({ conversationId, content, permission, cluster }) =>
    sessionsApi.sendToSession({ conversationId, content, permission, cluster })
  )
  h('sessions:wait', (o) => sessionsApi.waitForSession(o || {}))

  // 事件中枢：游标轮询（前端断线/切窗后按 seq 补齐）与近期回看
  h('events:since', (o) => getHub().since((o && o.cursor) || 0, { limit: (o && o.limit) || 200 }))
  h('events:recent', (o) => getHub().recent(o || {}))
  h('events:stats', () => ({
    seq: getHub().seq,
    size: getHub().size,
    listeners: getHub().listenerCount()
  }))

  // 运行日志：内存环形缓冲 + userData/logs/runtime.log（完整历史可打开目录查看）
  h('logs:list', (o) => runtimeLog.getRuntimeLog().list(o || {}))
  h('logs:stats', () => runtimeLog.getRuntimeLog().stats())
  h('logs:clear', () => runtimeLog.getRuntimeLog().clear())
  h('logs:openFolder', async () => {
    const dir = runtimeLog.getRuntimeLog().dir
    if (!dir) return false
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      // 目录已存在或创建失败时交给 shell 统一回报
    }
    const error = await shell.openPath(dir)
    return !error
  })

  // 生命周期钩子：读取元信息 + 保存（保存前做结构与阶段校验）
  h('hooks:meta', () => ({ stages: STAGES, actions: ACTIONS }))
  h('hooks:list', () => parseHooks(repos.getSetting(dbm.get(), 'agentHooks')))
  h('hooks:save', (list) => {
    const parsed = parseHooks(list)
    repos.setSetting(dbm.get(), 'agentHooks', JSON.stringify(parsed))
    return parsed
  })
  // 试运行：不产生副作用，只回报哪些规则会命中
  h('hooks:dryRun', ({ stage, ctx }) => {
    const rules = parseHooks(repos.getSetting(dbm.get(), 'agentHooks'))
    return runHooks(rules, String(stage || ''), ctx || {})
  })

  // sys
  h('sys:clipboardRead', () => clipboard.readText())
  h('sys:clipboardWrite', (t) => {
    clipboard.writeText(String(t == null ? '' : t))
    return true
  })
  h('sys:selectionCapture', () => captureSelectedText(clipboard))

  // screenshot overlay
  h('capture:start', () => {
    ctx.startCapture()
    return true
  })
  h('capture:finish', async (rect) => {
    windows.closeWindow('capture')
    const dataUrl = await captureRegion(rect)
    broadcast('chat:attachment', { dataUrl })
    windows.show('main')
    return true
  })
  h('capture:cancel', () => {
    windows.closeWindow('capture')
    return true
  })

  // app / windows
  h('app:showMain', (cid) => {
    windows.show('main')
    if (cid) broadcast('app:route', { conversationId: cid })
    return true
  })
  h('app:toggleMain', () => windows.toggle('main'))
  h('app:showQuickFromBall', () => {
    ctx.activateQuick()
    return true
  })
  h('app:quit', () => ctx.requestQuit())
  h('app:openExternal', (url) => {
    try {
      const u = new URL(url)
      if (!/^https?:$/.test(u.protocol)) return false
      shell.openExternal(u.toString())
      return true
    } catch {
      return false
    }
  })
  h('win:hide', (name) => {
    if (['quick', 'main', 'ball'].includes(name)) windows.hide(name)
    return true
  })
  h('win:close', (name) => {
    if (name === 'main') windows.closeWindow('main')
    return true
  })
  // 自绘标题栏的窗口控制（主窗口）
  h('win:minimize', () => {
    const win = windows.get('main')
    if (win && !win.isDestroyed()) win.minimize()
    return true
  })
  h('win:toggleMaximize', () => {
    const win = windows.get('main')
    if (!win || win.isDestroyed()) return false
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
    return win.isMaximized()
  })
  h('win:isMaximized', () => {
    const win = windows.get('main')
    return !!(win && !win.isDestroyed() && win.isMaximized())
  })
  h('app:info', () => ({
    version: ctx.version,
    commit: (ctx.buildInfo && ctx.buildInfo.commit) || '',
    builtAt: (ctx.buildInfo && ctx.buildInfo.builtAt) || '',
    dataDir: app.getPath('userData'),
    dbPath: dbm.info() && dbm.info().path,
    driver: dbm.info() && dbm.info().driver,
    platform: process.platform,
    node: process.versions.node
  }))
  // GitHub 更新：state 只读缓存（渲染层启动时补齐），check 触发一次真实检查。
  // 主进程还没初始化 updater（如仅注册 IPC 的场景）时返回空态而不是抛错。
  h('updater:state', () => {
    const u = getUpdater()
    return u ? u.getState() : null
  })
  h('updater:check', ({ force = true } = {}) => {
    const u = getUpdater()
    return u ? u.check({ force: !!force }) : null
  })
  h('autostart:get', () => app.getLoginItemSettings().openAtLogin)
  h('autostart:set', (v) => {
    app.setLoginItemSettings({ openAtLogin: !!v })
    return app.getLoginItemSettings().openAtLogin
  })
  h(
    'hotkeys:get',
    () =>
      repos.getSetting(dbm.get(), 'hotkeys') || {
        quick: 'Alt+Space',
        selection: 'Alt+Q',
        capture: 'Alt+S'
      }
  )
  h('hotkeys:set', (map) => {
    repos.setSetting(dbm.get(), 'hotkeys', map)
    return ctx.applyHotkeysNow()
  })

  // dialogs
  h('dialog:pickFiles', async (o) => {
    const r = await dialog.showOpenDialog(windows.get('main'), {
      properties: ['openFile', 'multiSelections'],
      filters: (o && o.filters) || [
        { name: '文档', extensions: ['pdf', 'docx', 'md', 'markdown', 'txt'] }
      ]
    })
    return r.canceled ? null : r.filePaths
  })
  h('dialog:pickDir', async () => {
    const r = await dialog.showOpenDialog(windows.get('main'), { properties: ['openDirectory'] })
    return r.canceled ? null : r.filePaths[0]
  })

  // backup
  h('data:export', async ({ includeKeys }) => {
    const dest = await dialog.showSaveDialog(windows.get('main'), {
      defaultPath: `Mini-Agent-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (dest.canceled || !dest.filePath) return null
    const r = exporter.exportAll(dbm.get(), dest.filePath, {
      includeKeys: !!includeKeys,
      decryptSecret
    })
    broadcast('app:notice', { level: 'success', message: `已导出到 ${dest.filePath}` })
    return r
  })
  h('data:import', async () => {
    const r = await dialog.showOpenDialog(windows.get('main'), {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }]
    })
    if (r.canceled || !r.filePaths.length) return null
    const res = exporter.importAll(dbm.get(), r.filePaths[0], { encryptSecret })
    broadcast('app:notice', { level: 'success', message: '导入完成' })
    broadcast('data:changed', res)
    return res
  })
}

module.exports = { registerIpc, providerOut, probeAllForProvider }
