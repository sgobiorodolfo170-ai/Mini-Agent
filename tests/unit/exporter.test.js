import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import { exportAll, importAll } from '../../electron/main/exporter'

function tmpFile() {
  return path.join(
    os.tmpdir(),
    `miniagent-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  )
}

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
})

function seed(db) {
  const pid = repos.saveProvider(db, { name: '中转', baseUrl: 'https://x/v1' })
  const kid = repos.addKey(db, { providerId: pid, label: 'k1', secretEnc: 'plain:sk-123' })
  const cid = repos.createConversation(db, { title: '会话一' }).id
  repos.insertMessage(db, { conversationId: cid, role: 'user', content: '问题' })
  repos.insertMessage(db, {
    conversationId: cid,
    role: 'assistant',
    content: '回答',
    status: 'done'
  })
  const kb = repos.createKb(db, { name: '库一', embedModel: 'emb' })
  const docId = repos.insertDoc(db, {
    kbId: kb.id,
    path: 'C:\\a.md',
    title: 'a.md',
    size: 3,
    hash: 'hh'
  })
  repos.insertChunks(db, docId, kb.id, [
    { seq: 0, text: '块', headingPath: null, vector: Float32Array.from([1, 2, 3]) }
  ])
  const runId = repos.createRun(db, { conversationId: cid, goal: '任务' })
  repos.logToolCall(db, {
    runId,
    step: 1,
    tool: 'list_dir',
    args: {},
    riskLevel: 'readonly',
    confirmedBy: 'auto',
    result: 'ok'
  })
  repos.setSetting(db, 'theme', 'dark')
  return { pid, kid, cid, kbId: kb.id, runId }
}

describe('exportAll / importAll', () => {
  it('roundtrips all data through a JSON file', async () => {
    const db1 = dbm.get()
    const ids = seed(db1)
    const file = tmpFile()
    const summary = await exportAll(db1, file, {
      includeKeys: true,
      decryptSecret: (s) => 'DEC:' + s
    })
    expect(summary.conversations).toBe(1)
    expect(summary.messages).toBe(2)
    expect(summary.secrets).toBe(1)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(raw.app).toBe('miniagent')
    expect(raw.secrets[0].secret).toBe('DEC:plain:sk-123')
    expect(raw.embeddings[0].embedding_b64).toBeTruthy()

    dbm.close()
    dbm.open(':memory:')
    const db2 = dbm.get()
    const res = await importAll(db2, file, { encryptSecret: (s) => 'ENC:' + s })
    expect(res.conversations).toBe(1)
    expect(res.keysWithSecret).toBe(1)
    expect(repos.listProviders(db2)[0].name).toBe('中转')
    expect(repos.listConversations(db2)[0].title).toBe('会话一')
    expect(repos.listMessages(db2, ids.cid)).toHaveLength(2)
    const key = repos.listAllKeysWithSecret(db2).find((k) => k.id === ids.kid)
    expect(key.secretEnc).toBe('ENC:DEC:plain:sk-123')
    const embs = repos.listEmbeddingsByKb(db2, ids.kbId)
    expect(embs).toHaveLength(1)
    expect(embs[0].vector[1]).toBeCloseTo(2, 5)
    expect(repos.getRunCalls(db2, ids.runId)).toHaveLength(1)
    expect(repos.getSetting(db2, 'theme')).toBe('dark')
    fs.rmSync(file, { force: true })
  })

  it('rejects foreign files', async () => {
    const file = tmpFile()
    fs.writeFileSync(file, JSON.stringify({ app: 'other' }))
    await expect(importAll(dbm.get(), file, {})).rejects.toThrow(/Mini Agent/)
    fs.rmSync(file, { force: true })
  })

  it('exports without secrets unless asked', async () => {
    const db = dbm.get()
    seed(db)
    const file = tmpFile()
    await exportAll(db, file, { includeKeys: false })
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(raw.secrets).toHaveLength(0)
    fs.rmSync(file, { force: true })
  })
})
