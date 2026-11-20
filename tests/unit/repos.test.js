import { beforeEach, describe, expect, it } from 'vitest'
import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
})

describe('schema + settings', () => {
  it('migrates to v3 and roundtrips settings', () => {
    const row = dbm.get().prepare('PRAGMA user_version').get()
    expect(row.user_version).toBe(dbm.SCHEMA_VERSION)
    expect(dbm.SCHEMA_VERSION).toBe(3)
    repos.setSetting(dbm.get(), 'theme', 'dark')
    repos.setSetting(dbm.get(), 'agentAuthorizedDirs', ['C:\\a', 'C:\\b'])
    expect(repos.getSetting(dbm.get(), 'theme')).toBe('dark')
    expect(repos.getSetting(dbm.get(), 'agentAuthorizedDirs')).toEqual(['C:\\a', 'C:\\b'])
    expect(repos.getAllSettings(dbm.get()).theme).toBe('dark')
  })
})

describe('providers + keys', () => {
  it('saves providers and manages key status', () => {
    const db = dbm.get()
    const pid = repos.saveProvider(db, {
      name: '中转',
      baseUrl: 'https://x/v1',
      models: [{ id: 'm1', vision: false }]
    })
    const kid = repos.addKey(db, { providerId: pid, label: '一号', secretEnc: 'plain:abc' })
    let keys = repos.listKeys(db, pid)
    expect(keys).toHaveLength(1)
    expect(keys[0].status).toBe('unknown')
    expect(keys[0].label).toBe('一号')
    repos.updateKeyStatus(db, kid, {
      status: 'cooldown',
      cooldownUntil: 123,
      rateCount: 2,
      lastError: '429'
    })
    keys = repos.listKeys(db, pid)
    expect(keys[0].status).toBe('cooldown')
    expect(keys[0].rateCount).toBe(2)
    expect(keys[0].cooldownUntil).toBe(123)
    const full = repos.getKeyWithSecret(db, kid)
    expect(full.secret_enc).toBe('plain:abc')
    repos.logKeyEvent(db, { apiKeyId: kid, kind: 'probe', result: 'ok', detail: '120ms' })
    expect(repos.listKeyEvents(db)[0].result).toBe('ok')
    repos.softDeleteProvider(db, pid)
    expect(repos.listProviders(db)).toHaveLength(0)
    expect(repos.listKeys(db, pid)).toHaveLength(0)
  })
})

describe('conversations + messages', () => {
  it('orders messages by seq and supports soft delete from', () => {
    const db = dbm.get()
    const cid = repos.createConversation(db, { title: '测试' }).id
    const m1 = repos.insertMessage(db, { conversationId: cid, role: 'user', content: '你好' })
    const m2 = repos.insertMessage(db, {
      conversationId: cid,
      role: 'assistant',
      content: '你好！',
      status: 'done'
    })
    const m3 = repos.insertMessage(db, { conversationId: cid, role: 'user', content: '再见' })
    let rows = repos.listMessages(db, cid)
    expect(rows.map((r) => r.id)).toEqual([m1.id, m2.id, m3.id])
    repos.softDeleteMessagesFrom(db, cid, m2.seq)
    rows = repos.listMessages(db, cid)
    expect(rows.map((r) => r.id)).toEqual([m1.id])
    repos.updateMessage(db, m1.id, { content: '改好了' })
    expect(repos.getMessage(db, m1.id).content).toBe('改好了')
    expect(repos.searchConversations(db, '改好')[0].id).toBe(cid)
  })

  it('soft deletes a single message', () => {
    const db = dbm.get()
    const cid = repos.createConversation(db, { title: '测试' }).id
    const m1 = repos.insertMessage(db, { conversationId: cid, role: 'user', content: '你好' })
    const m2 = repos.insertMessage(db, {
      conversationId: cid,
      role: 'assistant',
      content: '你好！'
    })
    expect(repos.softDeleteMessage(db, '不存在')).toBeNull()
    expect(repos.softDeleteMessage(db, m1.id)).toBeTruthy()
    const rows = repos.listMessages(db, cid)
    expect(rows.map((r) => r.id)).toEqual([m2.id])
    // 已删消息不影响 seq 分配（nextSeq 只统计未删）
    expect(repos.nextSeq(db, cid)).toBe(3)
  })
})

describe('projects + conversation categorization', () => {
  it('manages projects and detaches sessions on delete', () => {
    const db = dbm.get()
    const p1 = repos.createProject(db, { name: '项目A', path: 'C:\\a' })
    const p2 = repos.createProject(db, { name: '项目B', path: 'C:\\b' })
    expect(repos.listProjects(db).map((p) => p.name)).toEqual(['项目A', '项目B'])
    const up = repos.updateProject(db, p1.id, { name: '项目A2' })
    expect(up.name).toBe('项目A2')
    expect(up.path).toBe('C:\\a')
    const cid = repos.createConversation(db, { title: '归组会话', projectId: p1.id }).id
    expect(repos.getConversation(db, cid).projectId).toBe(p1.id)
    expect(repos.countProjectSessions(db, p1.id)).toBe(1)
    // 移动到另一项目
    repos.updateConversation(db, cid, { projectId: p2.id })
    expect(repos.getConversation(db, cid).projectId).toBe(p2.id)
    expect(repos.countProjectSessions(db, p1.id)).toBe(0)
    // patch 不带 projectId 时保留原值；显式 null 清除
    repos.updateConversation(db, cid, { title: '改名' })
    expect(repos.getConversation(db, cid).projectId).toBe(p2.id)
    repos.updateConversation(db, cid, { projectId: null })
    expect(repos.getConversation(db, cid).projectId).toBeNull()
    // 删除项目：其下会话归位「最近」
    const cid2 = repos.createConversation(db, { projectId: p2.id }).id
    repos.softDeleteProject(db, p2.id)
    expect(repos.listProjects(db).map((p) => p.id)).toEqual([p1.id])
    expect(repos.getConversation(db, cid2).projectId).toBeNull()
  })
})

describe('kb storage', () => {
  it('stores chunks with float32 embeddings and joins chunk text', () => {
    const db = dbm.get()
    const kb = repos.createKb(db, {
      name: '资料库',
      embedSource: 'local',
      embedModel: 'bge-small-zh-v1.5',
      embedQuant: 'int8'
    })
    expect(kb.embedSource).toBe('local')
    expect(kb.embedQuant).toBe('int8')
    // 远程库缺省
    const kb2 = repos.createKb(db, { name: '远程库', embedProviderId: 'p1', embedModel: 'emb-1' })
    expect(kb2.embedSource).toBe('remote')
    expect(kb2.embedQuant).toBeNull()
    // 更新嵌入配置
    const up = repos.updateKb(db, kb.id, { embedQuant: 'fp32' })
    expect(up.embedQuant).toBe('fp32')
    const docId = repos.insertDoc(db, {
      kbId: kb.id,
      path: 'C:\\a.md',
      title: 'a.md',
      size: 10,
      hash: 'h1'
    })
    const vec = Float32Array.from([0.1, 0.2, 0.3, 0.4])
    repos.insertChunks(db, docId, kb.id, [
      { seq: 0, text: '第一段', headingPath: 'A', vector: vec },
      { seq: 1, text: '第二段', headingPath: 'A > B', vector: vec }
    ])
    expect(repos.getKbStats(db, kb.id).chunks).toBe(2)
    const embs = repos.listEmbeddingsByKb(db, kb.id)
    expect(embs).toHaveLength(2)
    expect(embs[0].dim).toBe(4)
    expect(embs[0].vector[2]).toBeCloseTo(0.3, 5)
    const texts = repos.getChunkTexts(
      db,
      embs.map((e) => e.chunkId)
    )
    expect(texts[0].text).toBe('第一段')
    expect(texts[0].docTitle).toBe('a.md')
    repos.updateDocStatus(db, docId, { status: 'ready', chunkCount: 2 })
    expect(repos.listDocs(db, kb.id)[0].status).toBe('ready')
    repos.softDeleteDoc(db, docId)
    expect(repos.listDocs(db, kb.id)).toHaveLength(0)
    expect(repos.listEmbeddingsByKb(db, kb.id)).toHaveLength(0)
  })
})

describe('agent runs', () => {
  it('logs tool calls per run', () => {
    const db = dbm.get()
    const runId = repos.createRun(db, { goal: '整理文件', maxSteps: 10 })
    repos.logToolCall(db, {
      runId,
      step: 1,
      tool: 'list_dir',
      args: { path: 'C:\\x' },
      riskLevel: 'readonly',
      confirmedBy: 'auto',
      result: 'a.txt',
      durationMs: 12
    })
    repos.updateRun(db, runId, { status: 'done', stepsUsed: 1, endedAt: Date.now() })
    const runs = repos.listRuns(db)
    expect(runs[0].status).toBe('done')
    const calls = repos.getRunCalls(db, runId)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0].args).path).toBe('C:\\x')
  })
})
