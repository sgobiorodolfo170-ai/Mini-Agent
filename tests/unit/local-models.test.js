import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  CATALOG,
  getPackage,
  isDownloaded,
  listPackages,
  onnxPath,
  downloadPackage,
  deletePackage
} from '../../electron/main/rag/local-models'

let root

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'models-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function fakeFetch(chunks) {
  return async (url) => {
    if (!url.startsWith('https://hf-mirror.com/Xenova/')) {
      throw new Error('unexpected url: ' + url)
    }
    const total = chunks.reduce((a, b) => a + b.length, 0)
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(total) : null) },
      body: (async function* () {
        for (const c of chunks) {
          yield c
        }
      })()
    }
  }
}

describe('catalog', () => {
  it('has 4 packages: 2 models x fp32/int8 with correct dims', () => {
    expect(CATALOG).toHaveLength(4)
    for (const m of ['bge-small-zh-v1.5', 'bge-base-zh-v1.5']) {
      expect(
        CATALOG.filter((p) => p.model === m)
          .map((p) => p.quant)
          .sort()
      ).toEqual(['fp32', 'int8'])
    }
    expect(getPackage('bge-small-zh-v1.5:int8').dim).toBe(512)
    expect(getPackage('bge-base-zh-v1.5:fp32').dim).toBe(768)
    expect(getPackage('nope')).toBeNull()
  })
})

describe('isDownloaded / listPackages', () => {
  it('detects partial vs complete packages', () => {
    const pkg = getPackage('bge-small-zh-v1.5:fp32')
    expect(isDownloaded(root, pkg)).toBe(false)
    const dir = path.join(root, 'bge-small-zh-v1.5-fp32')
    fs.mkdirSync(dir, { recursive: true })
    // 仅 tokenizer.json → 未完成
    fs.writeFileSync(path.join(dir, 'tokenizer.json'), '{}')
    expect(isDownloaded(root, pkg)).toBe(false)
    // model.onnx 太小 → 未完成（防半截文件）
    fs.writeFileSync(path.join(dir, 'model.onnx'), Buffer.alloc(100))
    expect(isDownloaded(root, pkg)).toBe(false)
    // 足够大 + 三文件齐 → 完成
    fs.writeFileSync(path.join(dir, 'model.onnx'), Buffer.alloc(2 * 1024 * 1024))
    fs.writeFileSync(path.join(dir, 'config.json'), '{}')
    expect(isDownloaded(root, pkg)).toBe(true)
    const all = listPackages(root)
    expect(all.find((p) => p.id === 'bge-small-zh-v1.5:fp32').downloaded).toBe(true)
    expect(all.find((p) => p.id === 'bge-base-zh-v1.5:int8').downloaded).toBe(false)
    expect(onnxPath(root, pkg).endsWith('model.onnx')).toBe(true)
    expect(
      onnxPath(root, getPackage('bge-small-zh-v1.5:int8')).endsWith('model_quantized.onnx')
    ).toBe(true)
  })
})

describe('downloadPackage', () => {
  it('downloads all files flattened, reports progress, then skips on re-run', async () => {
    const pkg = getPackage('bge-small-zh-v1.5:fp32')
    const chunk = Buffer.alloc(64, 7)
    const progress = []
    const r = await downloadPackage(root, pkg, {
      fetchImpl: fakeFetch([chunk, chunk]),
      onProgress: (p) => progress.push(p)
    })
    expect(r.dir).toContain('bge-small-zh-v1.5-fp32')
    const dir = path.join(root, 'bge-small-zh-v1.5-fp32')
    expect(fs.readdirSync(dir).sort()).toEqual(['config.json', 'model.onnx', 'tokenizer.json'])
    expect(fs.statSync(path.join(dir, 'model.onnx')).size).toBe(128)
    // 没有 .part 残留
    expect(fs.readdirSync(dir).some((f) => f.endsWith('.part'))).toBe(false)
    // 进度事件：每文件下载完成 + 跳过时都有
    expect(progress.length).toBeGreaterThanOrEqual(pkg.files.length)

    // 再次下载：文件已存在 → 不再发请求
    let calls = 0
    await downloadPackage(root, pkg, {
      fetchImpl: async () => {
        calls++
        throw new Error('should not fetch')
      }
    })
    expect(calls).toBe(0)
  })

  it('propagates HTTP failure', async () => {
    const pkg = getPackage('bge-base-zh-v1.5:int8')
    await expect(
      downloadPackage(root, pkg, {
        fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } })
      })
    ).rejects.toThrow(/HTTP 404/)
  })

  it('deletePackage removes the directory', async () => {
    const pkg = getPackage('bge-small-zh-v1.5:int8')
    const dir = path.join(root, 'bge-small-zh-v1.5-int8')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'model_quantized.onnx'), 'x')
    deletePackage(root, pkg)
    expect(fs.existsSync(dir)).toBe(false)
  })
})
