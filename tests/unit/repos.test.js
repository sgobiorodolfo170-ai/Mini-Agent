import { beforeEach, describe, expect, it } from 'vitest'
import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
})

describe('schema + settings', () => {
  it('migrates to the current schema and roundtrips settings', () => {
    const row = dbm.get().prepare('PRAGMA user_version').get()
    expect(row.user_version).toBe(dbm.SCHEMA_VERSION)
    expect(dbm.SCHEMA_VERSION).toBe(14)
    repos.setSetting(dbm.get(), 'theme', 'dark')
    repos.setSetting(dbm.get(), 'agentAuthorizedDirs', ['C:\\a', 'C:\\b'])
    expect(repos.getSetting(dbm.get(), 'theme')).toBe('dark')
    expect(repos.getSetting(dbm.get(), 'agentAuthorizedDirs')).toEqual(['C:\\a', 'C:\\b'])
    expect(repos.getAllSettings(dbm.get()).theme).toBe('dark')
  })
})

describe('conversations permission（会话级权限记忆）', () => {
  it('create 默认 default，update 往返四级，非法值不写入', () => {
    const db = dbm.get()
    const cid = repos.createConversation(db, { title: '权限会话' }).id
    expect(repos.getConversation(db, cid).permission).toBe('default')

    for (const p of ['readonly', 'autonomous', 'full', 'default']) {
      repos.updateConversation(db, cid, { permission: p })
      expect(repos.getConversation(db, cid).permission).toBe(p)
    }
    // 非法权限值保持原值（收敛不放大）
    repos.updateConversation(db, cid, { permission: 'readonly' })
    repos.updateConversation(db, cid, { permission: 'superuser' })
    expect(repos.getConversation(db, cid).permission).toBe('readonly')

    // create 时非法值同样收敛 default
    const c2 = repos.createConversation(db, { title: '非法', permission: 'hacker' })
    expect(c2.permission).toBe('default')

    // 列表查询携带 permission 字段
    const list = repos.listConversations(db)
    expect(list.find((c) => c.id === cid).permission).toBe('readonly')
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
    expect(repos.listProviderKeys).toBeUndefined()
    repos.softDeleteProvider(db, pid)
    expect(repos.listProviders(db)).toHaveLength(0)
    expect(repos.listKeys(db, pid)).toHaveLength(0)
  })

  it('updateKeyStatus 缺省 lastUsedAt 时保留原值（round_robin 不被失败 Key 抢占）', () => {
    const db = dbm.get()
    const pid = repos.saveProvider(db, { name: 'P', baseUrl: 'https://x/v1' })
    const kid = repos.addKey(db, { providerId: pid, label: 'k', secretEnc: 'plain:x' })
    repos.updateKeyStatus(db, kid, { status: 'ok', lastUsedAt: 999 })
    expect(repos.getKeyWithSecret(db, kid).last_used_at).toBe(999)
    // 失败分支只带状态与错误，不带 lastUsedAt
    repos.updateKeyStatus(db, kid, { status: 'cooldown', lastError: '429', cooldownUntil: 1 })
    expect(repos.getKeyWithSecret(db, kid).last_used_at).toBe(999)
    // 显式传值仍然生效
    repos.updateKeyStatus(db, kid, { status: 'ok', lastUsedAt: 1234 })
    expect(repos.getKeyWithSecret(db, kid).last_used_at).toBe(1234)
  })
})

describe('会话来源（v4 迁移）', () => {
  it('人工会话默认 origin=user，且不携带父会话', () => {
    const db = dbm.get()
    const c = repos.createConversation(db, { title: '人工' })
    expect(c.origin).toBe('user')
    expect(c.parentId).toBeNull()
    expect(c.createdByRun).toBeNull()
  })

  it('Agent 创建的子会话记录 origin/parentId/createdByRun', () => {
    const db = dbm.get()
    const parent = repos.createConversation(db, { title: '父' })
    const child = repos.createConversation(db, {
      title: '子',
      origin: 'agent',
      parentId: parent.id,
      createdByRun: 'run-9'
    })
    expect(child).toMatchObject({ origin: 'agent', parentId: parent.id, createdByRun: 'run-9' })
    // 读回路径也要带上新字段（listConversations 与 getConversation）
    const listed = repos.listConversations(db).find((c) => c.id === child.id)
    expect(listed.origin).toBe('agent')
    expect(listed.parentId).toBe(parent.id)
  })

  it('listChildConversations / listAgentConversations 按来源过滤', () => {
    const db = dbm.get()
    const parent = repos.createConversation(db, { title: '父' })
    const a = repos.createConversation(db, {
      title: 'A',
      origin: 'agent',
      parentId: parent.id,
      createdByRun: 'r1'
    })
    const b = repos.createConversation(db, {
      title: 'B',
      origin: 'agent',
      parentId: parent.id,
      createdByRun: 'r2'
    })
    expect(
      repos
        .listChildConversations(db, parent.id)
        .map((c) => c.id)
        .sort()
    ).toEqual([a.id, b.id].sort())
    expect(repos.listAgentConversations(db, 'r1').map((c) => c.id)).toEqual([a.id])
    expect(
      repos
        .listAgentConversations(db)
        .map((c) => c.id)
        .sort()
    ).toEqual([a.id, b.id].sort())
  })

  it('软删的子会话不出现在子会话列表', () => {
    const db = dbm.get()
    const parent = repos.createConversation(db, { title: '父' })
    const child = repos.createConversation(db, {
      title: '子',
      origin: 'agent',
      parentId: parent.id
    })
    repos.softDeleteConversation(db, child.id)
    expect(repos.listChildConversations(db, parent.id)).toHaveLength(0)
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
    const p1 = repos.createProject(db, {
      name: '项目A',
      path: 'C:\\a',
      workspaceVerifyCommand: 'npm test'
    })
    const p2 = repos.createProject(db, { name: '项目B', path: 'C:\\b' })
    expect(repos.listProjects(db).map((p) => p.name)).toEqual(['项目A', '项目B'])
    expect(p1.workspaceVerifyCommand).toBe('npm test')
    const up = repos.updateProject(db, p1.id, { name: '项目A2', workspaceVerifyCommand: '' })
    expect(up.name).toBe('项目A2')
    expect(up.workspaceVerifyCommand).toBe('')
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

  it('persists P8 project verification, retry links and tool ledger state', () => {
    const db = dbm.get()
    const project = repos.createProject(db, {
      name: 'P8',
      path: 'C:\\p8',
      workspaceVerifyCommand: 'npm test',
      workspaceConflictStrategy: 'theirs'
    })
    expect(repos.listProjects(db)[0].workspaceVerifyCommand).toBe('npm test')
    expect(repos.listProjects(db)[0].workspaceConflictStrategy).toBe('theirs')
    const conversation = repos.createConversation(db, { title: 'P8', projectId: project.id })
    repos.updateConversation(db, conversation.id, { title: 'P8 updated' })
    expect(repos.listConversations(db)[0].title).toBe('P8 updated')
    expect(repos.countProjectSessions(db, project.id)).toBe(1)

    const original = repos.createRunEx(db, {
      conversationId: conversation.id,
      goal: 'original',
      status: 'interrupted'
    })
    const retry = repos.createRunEx(db, {
      conversationId: conversation.id,
      goal: 'retry',
      status: 'queued',
      retryOfRunId: original.id
    })
    repos.setRunWorkspace(db, retry.id, { mode: 'worktree', path: 'C:\\wt' })
    repos.updateRunAcceptance(db, retry.id, { status: 'accepted', result: { verdict: 'accepted' } })
    expect(repos.getRun(db, retry.id)).toMatchObject({
      retryOfRunId: original.id,
      acceptanceStatus: 'accepted',
      workspaceJson: JSON.stringify({ mode: 'worktree', path: 'C:\\wt' })
    })
    expect(repos.listRuns(db).map((run) => run.id)).toContain(retry.id)

    const callId = repos.startToolCall(db, {
      runId: retry.id,
      step: 1,
      tool: 'write_file',
      args: { path: 'a.txt' },
      riskLevel: 'side_effect',
      confirmedBy: 'desktop',
      callId: 'p8-call'
    })
    expect(repos.hasUnfinishedToolCalls(db, retry.id)).toBe(true)
    repos.finishToolCall(db, callId, { result: 'ok', durationMs: 1 })
    expect(repos.hasUnfinishedToolCalls(db, retry.id)).toBe(false)
    expect(repos.getToolCallByCallId(db, retry.id, 'p8-call').status).toBe('done')
    expect(() =>
      repos.updateProject(db, project.id, { workspaceConflictStrategy: 'invalid' })
    ).toThrow(/冲突策略/)

    repos.softDeleteProject(db, project.id)
    expect(repos.getConversation(db, conversation.id).projectId).toBeNull()
  })
})

describe('kb storage', () => {
  it('每个项目最多有一个工作区索引，并与普通知识库隔离', () => {
    const db = dbm.get()
    const project = repos.createProject(db, { name: '项目', path: 'C:\\work' })
    const kb = repos.createKb(db, {
      name: '项目 · 工作区索引',
      projectId: project.id,
      kind: 'workspace',
      rootPath: project.path,
      embedSource: 'local',
      embedModel: 'bge-small-zh-v1.5',
      embedQuant: 'int8'
    })
    expect(repos.getProjectKb(db, project.id)).toMatchObject({
      id: kb.id,
      projectId: project.id,
      kind: 'workspace',
      rootPath: 'C:\\work'
    })
    expect(repos.listKbs(db)[0].kind).toBe('workspace')
    expect(() =>
      repos.createKb(db, {
        name: '重复索引',
        projectId: project.id,
        kind: 'workspace',
        rootPath: project.path
      })
    ).toThrow(/UNIQUE/)
    repos.softDeleteKb(db, kb.id)
    expect(repos.getProjectKb(db, project.id)).toBeUndefined()
  })

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

  it('启动时回收僵尸 running 运行记录', () => {
    const os = require('os')
    const fs = require('fs')
    const path = require('path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-'))
    const file = path.join(dir, 'zombie.db')
    dbm.close()
    dbm.open(file)
    const runId = repos.createRun(dbm.get(), { goal: '异常退出', maxSteps: 5 })
    expect(repos.listRuns(dbm.get())[0].status).toBe('running')
    // 模拟进程被强杀后重新启动：同一份文件重新打开应把 running 收敛为 stopped
    dbm.close()
    dbm.open(file)
    const after = repos.listRuns(dbm.get()).find((r) => r.id === runId)
    expect(after.status).toBe('stopped')
    expect(after.ended_at).toBeGreaterThan(0)
    dbm.close()
    fs.rmSync(dir, { recursive: true, force: true })
    dbm.open(':memory:')
  })
})
