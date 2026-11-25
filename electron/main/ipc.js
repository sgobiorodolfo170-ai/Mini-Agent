const { app, clipboard, dialog, ipcMain, screen, shell } = require('electron')
const fs = require('fs')
const pathMod = require('path')
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
const terminal = require('./terminal')
const sideTask = require('./side-task')
const { isPathAllowed } = require('./agent/guard')
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
  h('chat:searchMessages', (o) => repos.searchMessages(dbm.get(), o || {}))
  h('conversations:messages', (id) => repos.listMessages(dbm.get(), id).map(gateway.msgOut))

  // 工作区文件：浏览 / 读取 / 保存，路径限制在项目工作目录与 Agent 授权目录内
  const workspaceRoots = () => {
    const db = dbm.get()
    const projects = repos.listProjects(db).map((p) => ({ id: p.id, name: p.name, path: p.path }))
    const raw = repos.getSetting(db, 'agentAuthorizedDirs')
    const extra = Array.isArray(raw) ? raw : []
    return [
      ...projects,
      ...extra.map((p, i) => ({
        id: 'dir-' + i,
        name: pathMod.basename(String(p)) || String(p),
        path: String(p)
      }))
    ]
  }
  const assertWorkspace = (target) => {
    const p = String(target || '')
    if (!p) throw new Error('缺少文件路径')
    if (!isPathAllowed(workspaceRoots().map((r) => r.path), p)) {
      throw new Error('路径不在项目工作区内：' + p)
    }
    return p
  }
  h('workspace:roots', () => workspaceRoots())
  h('workspace:list', async ({ path: p } = {}) => {
    const dir = assertWorkspace(p)
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    return entries
      .map((e) => ({ name: e.name, path: pathMod.join(dir, e.name), dir: e.isDirectory() }))
      .sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
      .slice(0, 500)
  })
  h('workspace:read', async ({ path: p } = {}) => {
    const file = assertWorkspace(p)
    const st = await fs.promises.stat(file)
    if (st.isDirectory()) throw new Error('目标是目录，无法作为文件打开')
    if (st.size > 2 * 1024 * 1024) throw new Error('文件超过 2MB，暂不支持在编辑器中打开')
    return {
      content: (await fs.promises.readFile(file)).toString('utf8'),
      size: st.size,
      mtime: st.mtimeMs
    }
  })
  h('workspace:write', async ({ path: p, content } = {}) => {
    const file = assertWorkspace(p)
    const text = String(content == null ? '' : content)
    await fs.promises.writeFile(file, text, 'utf8')
    return { size: Buffer.byteLength(text) }
  })

  // 终端控制台：执行目录同样限制在工作区内
  h('terminal:run', ({ id, command, cwd } = {}) => {
    const dir = cwd ? assertWorkspace(cwd) : undefined
    return terminal.run({ id, command, cwd: dir })
  })
  h('terminal:stop', (o) => terminal.stop(o || {}))

  // 侧边任务：临时子会话，只做流式回传，不写入主会话历史
  h('side:send', (o) => sideTask.send(o || {}))
  h('side:stop', (o) => sideTask.stop(o || {}))


  // projects（项目工作目录：会话分类 + Agent 命令执行目录）
  h('projects:list', () => {
    const db = dbm.get()
    return repos.listProjects(db).map((p) => ({
      ...p,
      sessionCount: repos.countProjectSessions(db, p.id),
      workspaceIndexKbId: repos.getProjectKb(db, p.id)?.id || null
    }))
  })
  h('projects:create', (o) => {
    const name = String((o && o.name) || '').trim()
    const dir = String((o && o.path) || '').trim()
    if (!name) throw new Error('项目名称不能为空')
    if (!dir) throw new Error('请选择项目工作目录')
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
      throw new Error('工作目录不存在或不是文件夹')
    const verifyCommand = String((o && o.workspaceVerifyCommand) || '').trim()
    if (verifyCommand.length > 500) throw new Error('验收命令不能超过 500 个字符')
    const conflictStrategy = String((o && o.workspaceConflictStrategy) || 'manual')
    if (!['manual', 'ours', 'theirs'].includes(conflictStrategy))
      throw new Error('工作区冲突策略无效')
    const r = repos.createProject(dbm.get(), {
      name,
      path: dir,
      workspaceMode: o && o.workspaceMode,
      workspaceAutoMerge: o && o.workspaceAutoMerge !== undefined ? o.workspaceAutoMerge : 1,
      workspaceVerifyCommand: verifyCommand,
      workspaceConflictStrategy: conflictStrategy
    })
    const workspaceIndex =
      o && o.createWorkspaceIndex === true ? rag.startProjectIndex({ projectId: r.id }) : null
    broadcast('projects:changed', {})
    return workspaceIndex ? { ...r, workspaceIndex } : r
  })
  h('projects:update', ({ id, patch }) => {
    const db = dbm.get()
    if (patch && patch.path !== undefined) {
      const dir = String(patch.path || '').trim()
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory())
        throw new Error('工作目录不存在或不是文件夹')
      patch = { ...patch, path: dir }
    }
    if (patch && patch.workspaceVerifyCommand !== undefined) {
      const verifyCommand = String(patch.workspaceVerifyCommand || '').trim()
      if (verifyCommand.length > 500) throw new Error('验收命令不能超过 500 个字符')
      patch = { ...patch, workspaceVerifyCommand: verifyCommand }
    }
    if (patch && patch.workspaceConflictStrategy !== undefined) {
      const strategy = String(patch.workspaceConflictStrategy || 'manual')
      if (!['manual', 'ours', 'theirs'].includes(strategy)) throw new Error('工作区冲突策略无效')
      patch = { ...patch, workspaceConflictStrategy: strategy }
    }
    const r = repos.updateProject(db, id, patch || {})
    if (!r) throw new Error('项目不存在')
    if (patch && patch.path !== undefined) {
      const kb = repos.getProjectKb(db, id)
      if (kb) {
        db.prepare('UPDATE kbs SET root_path=?, updated_at=? WHERE id=?').run(
          r.path,
          Date.now(),
          kb.id
        )
        rag.startProjectIndex({ projectId: id, rebuild: true })
      }
    }
    broadcast('projects:changed', {})
    return r
  })
  h('projects:delete', (id) => {
    const db = dbm.get()
    const kb = repos.getProjectKb(db, id)
    if (kb) {
      faissIndex.invalidate(kb.id)
      repos.softDeleteKb(db, kb.id)
      broadcast('kb:changed', { kbId: kb.id })
    }
    repos.softDeleteProject(db, id)
    broadcast('projects:changed', {})
    return true
  })
  h('projects:index', ({ projectId, rebuild = false } = {}) => {
    const result = rag.startProjectIndex({ projectId, rebuild: !!rebuild })
    broadcast('projects:changed', {})
    return result
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
    broadcast('kb:changed', { kbId: id })
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
  h('agent:run', ({ conversationId, goal, permission, cluster, kbIds }) =>
    agent.startAgentRun({ conversationId, goal, permission, cluster, kbIds })
  )
  h('agent:status', (id) => agent.getRunStatus(id))
  h('agent:result', ({ runId, maxChars }) => agent.getRunResult(runId, maxChars))
  h('agent:stop', (runId) => agent.stopRun(runId))
  h('agent:pause', (runId) => agent.pauseRun(runId))
  h('agent:resume', (runId) => agent.resumeRun(runId))
  h('agent:recovery', (runId) => agent.getRunRecovery(runId))
  h('agent:recovery:continue', (o) =>
    agent.resumeInterruptedRun(o && o.runId, { actor: 'desktop', reason: o && o.reason })
  )
  h('agent:recovery:retry', (o) =>
    agent.retryInterruptedRun(o && o.runId, {
      actor: 'desktop',
      reason: o && o.reason,
      idempotencyKey: o && o.idempotencyKey
    })
  )
  h('agent:respond', (o) => agent.respondConfirm(o))
  h('agent:acceptance:decide', (o) => agent.decideAcceptance(o))
  h('agent:runs', () => repos.listRuns(dbm.get(), 50))
  h('agent:calls', (runId) => repos.getRunCalls(dbm.get(), runId))
  h('agent:graph', (runId) => agent.getGraphForParent(runId))
  h('agent:graph:layout:get', (runId) => agent.getGraphLayoutForParent(runId))
  h('agent:graph:layout:save', (o) =>
    agent.saveGraphLayoutForParent(o && o.runId, {
      layout: o && o.layout,
      viewport: o && o.viewport,
      baseRevision: o && o.baseRevision
    })
  )
  h('agent:graph:mutate', (o) => agent.mutateRunGraph(o || {}))
  h('computer:stop', () => agent.stopComputer())

  // 内置浏览器：仅主窗口可调用，Agent 通过主进程 BrowserService 访问自己的临时标签。
  const requireBrowser = () => {
    const service = ctx.browser && ctx.browser()
    if (!service) throw new Error('内置浏览器尚未初始化')
    return service
  }
  const bh = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      const main = windows.get('main')
      if (!main || event.sender !== main.webContents) {
        throw new Error('仅主窗口可控制内置浏览器')
      }
      return fn(...args)
    })
  bh('browser:state', () => requireBrowser().getState())
  bh('browser:setEnabled', ({ enabled } = {}) => {
    repos.setSetting(dbm.get(), 'browserEnabled', enabled === true)
    return requireBrowser().setEnabled(enabled === true)
  })
  bh('browser:open', ({ url = 'about:blank' } = {}) => requireBrowser().open({ url, kind: 'user' }))
  bh('browser:navigate', ({ tabId, url } = {}) => requireBrowser().navigate(tabId, url))
  bh('browser:activate', ({ tabId } = {}) => requireBrowser().activate(tabId))
  bh('browser:close', ({ tabId } = {}) => requireBrowser().close(tabId))
  bh('browser:command', ({ tabId, command } = {}) => requireBrowser().command(tabId, command))
  bh('browser:toggleDevTools', ({ tabId } = {}) => requireBrowser().toggleDevTools(tabId))
  bh('browser:selectElement', ({ tabId } = {}) => requireBrowser().selectElement(tabId))
  bh('browser:cancelElementSelection', ({ tabId } = {}) =>
    requireBrowser().cancelElementSelection(tabId)
  )
  bh('browser:inspectorState', ({ tabId } = {}) => requireBrowser().inspectorState(tabId))
  bh('browser:updateElementStyles', ({ tabId, elementId, styles, resetProperties } = {}) =>
    requireBrowser().updateElementStyles(tabId, elementId, styles, resetProperties)
  )
  bh('browser:resetElementStyles', ({ tabId, elementId } = {}) =>
    requireBrowser().resetElementStyles(tabId, elementId)
  )
  bh('browser:setDevice', ({ tabId, device } = {}) => requireBrowser().setDevice(tabId, device))
  bh('browser:clearDevice', ({ tabId } = {}) => requireBrowser().clearDevice(tabId))
  bh('browser:attach', ({ tabId, bounds, options } = {}) =>
    requireBrowser().attach(tabId, bounds, options)
  )
  bh('browser:detach', () => requireBrowser().detach())
  bh('browser:takeover', ({ tabId } = {}) => requireBrowser().takeover(tabId))
  bh('browser:release', ({ tabId } = {}) => requireBrowser().release(tabId))
  bh('browser:screenshot', ({ tabId } = {}) => requireBrowser().screenshot(tabId))
  bh('browser:clearData', () => requireBrowser().clearData())

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
  // 内置浏览器面板占用横向空间时，主窗口临时拓宽同样的宽度，
  // 保证会话区宽度不因展开/折叠而跳变；折叠时只回收此前实际加宽的部分。
  let panelGrow = { width: 0, x: null }
  h('win:resizeForPanel', (delta) => {
    const win = windows.get('main')
    if (!win || win.isDestroyed()) return { applied: 0 }
    const d = Math.round(Number(delta) || 0)
    if (!d) return { applied: 0 }
    // 最大化/全屏时无法调整尺寸；收起面板时清空记录，避免之后按过期加宽量回收
    if (win.isMaximized() || win.isFullScreen()) {
      if (d < 0) panelGrow = { width: 0, x: null }
      return { applied: 0 }
    }
    const b = win.getBounds()
    const wa = screen.getDisplayMatching(b).workArea
    if (d > 0) {
      if (panelGrow.x === null) panelGrow.x = b.x
      // 优先向右扩展，右侧到屏幕边缘后向左补足，始终不越出可用工作区
      const growRight = Math.min(d, Math.max(0, wa.x + wa.width - (b.x + b.width)))
      const growLeft = Math.min(d - growRight, Math.max(0, b.x - wa.x))
      const grown = growRight + growLeft
      if (!grown) return { applied: 0 }
      panelGrow.width += grown
      win.setBounds({ x: b.x - growLeft, y: b.y, width: b.width + grown, height: b.height })
      return { applied: grown }
    }
    const minWidth = win.getMinimumSize()[0] || 0
    const applied = Math.min(panelGrow.width, -d, Math.max(0, b.width - minWidth))
    if (!applied) return { applied: 0 }
    const width = b.width - applied
    const x =
      panelGrow.x === null
        ? b.x
        : Math.min(Math.max(panelGrow.x, wa.x), Math.max(wa.x, wa.x + wa.width - width))
    panelGrow.width -= applied
    if (!panelGrow.width) panelGrow.x = null
    win.setBounds({ x, y: b.y, width, height: b.height })
    return { applied }
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
