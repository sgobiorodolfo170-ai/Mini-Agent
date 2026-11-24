import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import dbm from '../../electron/store/db'
import repos from '../../electron/store/repos'
import rag from '../../electron/main/rag/index'
import localModels from '../../electron/main/rag/local-models'
import notify from '../../electron/main/notify'
import { collectWorkspaceFiles } from '../../electron/main/rag/workspace-files'

let dir
let events

beforeEach(() => {
  dbm.close()
  dbm.open(':memory:')
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'miniagent-workspace-index-'))
  events = []
  notify.setBroadcaster((channel, payload) => events.push({ channel, payload }))
  vi.spyOn(localModels, 'listPackages').mockReturnValue([])
})

afterEach(() => {
  notify.setBroadcaster(null)
  vi.restoreAllMocks()
  dbm.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

function seedEmbedding() {
  const providerId = repos.saveProvider(dbm.get(), {
    name: 'Embedding',
    baseUrl: 'https://mock/v1',
    models: [{ id: 'text-embedding-3-small' }]
  })
  repos.addKey(dbm.get(), { providerId, label: '', secretEnc: 'plain:sk-test' })
  vi.stubGlobal('fetch', async (_url, options) => {
    const input = JSON.parse(options.body).input
    return {
      ok: true,
      json: async () => ({
        data: input.map((_text, index) => ({ index, embedding: [1, 0] }))
      })
    }
  })
  return providerId
}

async function waitForDone(kbId) {
  for (let i = 0; i < 200; i++) {
    const docs = repos.listDocs(dbm.get(), kbId)
    if (docs.length && docs.every((doc) => doc.status !== 'pending')) return docs
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('索引等待超时')
}

describe('项目工作区索引', () => {
  it('扫描源码和文档，跳过依赖、二进制与大文件', async () => {
    fs.mkdirSync(path.join(dir, 'src'))
    fs.mkdirSync(path.join(dir, 'node_modules', 'pkg'), { recursive: true })
    fs.mkdirSync(path.join(dir, '.git'))
    fs.writeFileSync(path.join(dir, 'README.md'), '# 项目说明')
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM node:24')
    fs.writeFileSync(path.join(dir, 'credentials.json'), '{"secret":"ignored"}')
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const answer = 42')
    fs.writeFileSync(path.join(dir, 'src', 'binary.js'), Buffer.from([1, 0, 2]))
    fs.writeFileSync(path.join(dir, 'src', 'large.ts'), 'x'.repeat(1024 * 1024 + 1))
    fs.writeFileSync(path.join(dir, 'node_modules', 'pkg', 'index.js'), 'ignored')
    fs.writeFileSync(path.join(dir, '.git', 'config'), 'ignored')
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=ignored')

    const files = await collectWorkspaceFiles(dir)
    expect(files.map((file) => path.relative(dir, file)).sort()).toEqual([
      'Dockerfile',
      'README.md',
      path.join('src', 'app.ts')
    ])
  })

  it('创建项目索引后可检索，重建会同步新增和删除的文件', async () => {
    seedEmbedding()
    fs.mkdirSync(path.join(dir, 'src'))
    fs.writeFileSync(path.join(dir, 'README.md'), '# WORKSPACE_INDEX_MARKER\n\n项目架构说明')
    fs.writeFileSync(path.join(dir, 'src', 'app.ts'), 'export const workspaceFeature = true')
    const project = repos.createProject(dbm.get(), { name: '测试项目', path: dir })

    const started = rag.startProjectIndex({ projectId: project.id })
    expect(started.started).toBe(true)
    const docs = await waitForDone(started.kbId)
    expect(docs).toHaveLength(2)
    expect(docs.every((doc) => doc.status === 'ready')).toBe(true)
    expect(docs.map((doc) => doc.title).sort()).toEqual(
      ['README.md', path.join('src', 'app.ts')].sort()
    )
    const kb = repos.getProjectKb(dbm.get(), project.id)
    expect(kb).toMatchObject({
      kind: 'workspace',
      rootPath: dir,
      embedModel: 'text-embedding-3-small'
    })

    const result = await rag.retrieveProjectKb(dbm.get(), project.id, '项目架构')
    expect(result.blocks).toHaveLength(2)
    const readme = result.blocks.find((block) => block.title === 'README.md')
    expect(readme.n).toBeGreaterThan(0)
    expect(readme.text).toContain('WORKSPACE_INDEX_MARKER')
    expect(await rag.retrieveProjectKb(dbm.get(), 'other-project', '项目架构')).toBeNull()

    fs.rmSync(path.join(dir, 'src', 'app.ts'))
    fs.writeFileSync(path.join(dir, 'new.py'), 'print("new file")')
    await rag.rebuildKb({ kbId: kb.id })
    const rebuilt = await waitForDone(kb.id)
    expect(rebuilt.map((doc) => doc.title).sort()).toEqual(['README.md', 'new.py'].sort())
    expect(events.some((event) => event.payload?.workspace && event.payload?.done)).toBe(true)
  })

  it('没有可用 Embedding 时保留项目索引并提供可恢复提示', () => {
    fs.writeFileSync(path.join(dir, 'README.md'), '# 项目')
    const project = repos.createProject(dbm.get(), { name: '未配置', path: dir })
    const result = rag.startProjectIndex({ projectId: project.id })
    expect(result.started).toBe(false)
    expect(result.error).toMatch(/Embedding/)
    expect(repos.getProjectKb(dbm.get(), project.id)).toMatchObject({ kind: 'workspace' })
    expect(repos.listDocs(dbm.get(), result.kbId)).toEqual([])
  })
})
