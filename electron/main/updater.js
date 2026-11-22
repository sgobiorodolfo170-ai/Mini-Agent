const DEFAULT_REPO = 'sgobiorodolfo170-ai/Mini-Agent'
const API_BASE = 'https://api.github.com'
const CHECK_TTL_MS = 6 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15000

// GitHub 更新检查：当前安装（版本号 + 构建提交）与远端 main 分支对比。
// 判定顺序：同提交 → 已是最新；compare.ahead_by > 0 → 有更新（可给出落后提交数）；
// 本地提交未发布（compare 404）时退回版本号比较，避免把「本地更靠前」误判为可更新。
// 纯逻辑部分（版本比较 / 状态判定）与网络读取分离，便于单测与注入假数据源。

function parseVersion(input) {
  const m = String(input || '')
    .trim()
    .match(/^v?(\d+)\.(\d+)\.(\d+)/i)
  if (!m) return null
  return [Number(m[1]), Number(m[2]), Number(m[3])]
}

function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1
  }
  return 0
}

function shortSha(sha) {
  return sha ? String(sha).slice(0, 7) : ''
}

function resolveUpdateState({ current = {}, latest = null, compare = null } = {}) {
  const currentInfo = {
    version: current.version || '',
    commit: current.commit || '',
    shortCommit: shortSha(current.commit)
  }
  const base = {
    available: false,
    behind: null,
    reason: 'unknown',
    current: currentInfo,
    latest: null
  }
  if (!latest || !latest.commit) return base

  const latestInfo = { ...latest, shortCommit: latest.shortCommit || shortSha(latest.commit) }
  const state = { ...base, latest: latestInfo }

  if (currentInfo.commit && currentInfo.commit === latestInfo.commit) {
    return { ...state, reason: 'up-to-date' }
  }
  if (compare && Number.isFinite(compare.ahead_by)) {
    if (compare.ahead_by > 0) {
      return { ...state, available: true, behind: compare.ahead_by, reason: 'commit-ahead' }
    }
    // 远端没有超出本地的提交（本地更靠前或一致）——不提示更新
    return { ...state, reason: 'up-to-date' }
  }
  const delta = compareVersions(latestInfo.version, currentInfo.version)
  if (delta > 0) return { ...state, available: true, reason: 'version-newer' }
  return { ...state, reason: delta < 0 ? 'local-newer' : 'up-to-date' }
}

async function fetchJson(fetchImpl, url, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('当前运行时不支持网络请求')
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null
  const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'miniagent-updater'
      },
      signal: ctrl ? ctrl.signal : undefined
    })
    if (!res || !res.ok) throw new Error(`GitHub 响应 ${res ? res.status : '异常'}`)
    return await res.json()
  } catch (e) {
    // AbortError 的原始文案是英文 "This operation was aborted"，对用户没有意义
    if (e && (e.name === 'AbortError' || /aborted/i.test(String(e.message || '')))) {
      throw new Error(`请求 GitHub 超时（${Math.round(timeoutMs / 1000)}s）`)
    }
    throw e
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function readRemote(fetchImpl, repo, currentCommit, { timeoutMs } = {}) {
  const commits = await fetchJson(
    fetchImpl,
    `${API_BASE}/repos/${repo}/commits?per_page=1&sha=main`,
    { timeoutMs }
  )
  const head = Array.isArray(commits) ? commits[0] : null
  if (!head || !head.sha) throw new Error('未取到远端提交')

  const latest = {
    commit: head.sha,
    shortCommit: shortSha(head.sha),
    version: '',
    message: String((head.commit && head.commit.message) || '').split('\n')[0],
    date: (head.commit && head.commit.author && head.commit.author.date) || null,
    url: head.html_url || `https://github.com/${repo}/commit/${head.sha}`
  }

  // 版本号是辅助信号：源码不一定每次提交都改版本，取不到也不影响提交比较
  try {
    const pkg = await fetchJson(
      fetchImpl,
      `${API_BASE}/repos/${repo}/contents/package.json?ref=main`,
      { timeoutMs }
    )
    if (pkg && pkg.content) {
      const text = Buffer.from(pkg.content, 'base64').toString('utf8')
      latest.version = JSON.parse(text).version || ''
    }
  } catch {
    latest.version = ''
  }

  let compare = null
  if (currentCommit && currentCommit !== latest.commit) {
    try {
      const raw = await fetchJson(
        fetchImpl,
        `${API_BASE}/repos/${repo}/compare/${currentCommit}...${latest.commit}`,
        { timeoutMs }
      )
      compare = {
        ahead_by: Number(raw && raw.ahead_by) || 0,
        behind_by: Number(raw && raw.behind_by) || 0
      }
    } catch {
      // 本地提交尚未发布到 GitHub（compare 404）：按版本号兜底
      compare = null
    }
  }

  latest.compareUrl = currentCommit
    ? `https://github.com/${repo}/compare/${currentCommit}...${latest.commit}`
    : `https://github.com/${repo}/releases`

  return { latest, compare }
}

function emptyState(current = {}) {
  return {
    available: false,
    behind: null,
    reason: 'idle',
    checkedAt: 0,
    error: null,
    current: {
      version: current.version || '',
      commit: current.commit || '',
      shortCommit: shortSha(current.commit)
    },
    latest: null
  }
}

// feed：{ latest, compare } 或返回该结构的函数。测试/e2e 用它替代真实网络。
function createUpdateChecker(options = {}) {
  const {
    currentVersion = '',
    currentCommit = '',
    repo = DEFAULT_REPO,
    fetchImpl = globalThis.fetch,
    ttlMs = CHECK_TTL_MS,
    timeoutMs = REQUEST_TIMEOUT_MS,
    now = Date.now,
    feed = null,
    onState = null
  } = options

  let state = emptyState({ version: currentVersion, commit: currentCommit })
  let pending = null
  let feedSource = feed

  function publish(next) {
    state = next
    if (typeof onState === 'function') {
      try {
        onState(state)
      } catch {
        /* 广播失败不影响检查结果 */
      }
    }
    return state
  }

  async function run() {
    const current = { version: currentVersion, commit: currentCommit }
    try {
      const remote =
        typeof feedSource === 'function'
          ? await feedSource()
          : feedSource || (await readRemote(fetchImpl, repo, currentCommit, { timeoutMs }))
      if (!remote || !remote.latest) throw new Error('更新源无响应')
      const resolved = resolveUpdateState({
        current,
        latest: remote.latest,
        compare: remote.compare
      })
      return publish({ ...resolved, checkedAt: now(), error: null })
    } catch (e) {
      // 网络/接口失败时保留上次判定，避免更新入口闪烁
      return publish({
        ...state,
        reason: state.reason === 'idle' ? 'error' : state.reason,
        checkedAt: now(),
        error: String((e && e.message) || e)
      })
    }
  }

  function check({ force = false } = {}) {
    if (pending) return pending
    if (!force && state.checkedAt && now() - state.checkedAt < ttlMs) {
      return Promise.resolve(state)
    }
    pending = run().finally(() => {
      pending = null
    })
    return pending
  }

  let timer = null

  function start({ delayMs = 3000, intervalMs = ttlMs } = {}) {
    if (timer) return
    const kick = setTimeout(() => {
      check()
    }, delayMs)
    if (kick.unref) kick.unref()
    timer = setInterval(() => check({ force: true }), intervalMs)
    if (timer.unref) timer.unref()
  }

  function stop() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    check,
    start,
    stop,
    getState: () => state,
    // 供测试替换数据源，避免重开实例
    setFeed: (next) => {
      feedSource = next
    }
  }
}

let instance = null
function initUpdater(opts) {
  instance = createUpdateChecker(opts)
  return instance
}

function getUpdater() {
  return instance
}

function stopUpdater() {
  if (instance) instance.stop()
}

module.exports = {
  DEFAULT_REPO,
  CHECK_TTL_MS,
  parseVersion,
  compareVersions,
  resolveUpdateState,
  readRemote,
  createUpdateChecker,
  initUpdater,
  getUpdater,
  stopUpdater
}
