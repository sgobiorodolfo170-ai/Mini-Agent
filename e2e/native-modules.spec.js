import { describe, expect, it } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electronPath = createRequire(import.meta.url)('electron')

// 原生模块 ABI 冒烟：faiss-node / onnxruntime-node（NAPI 二进制）必须能在
// Electron 主进程内加载并工作。单测的 Node 环境与 Electron 的 ABI 不同，
// 这是只有真实 Electron 能回答的问题。
describe('原生模块 ABI（真实 Electron 主进程）', () => {
  it(
    'spike 脚本在 Electron 内加载并检索 faiss / 创建 ORT Tensor',
    async () => {
      const { stdout } = await run(
        electronPath,
        [path.join(root, 'scripts', 'spike-electron-native.js')],
        { cwd: root, timeout: 90000 }
      )
      const m = stdout.match(/SPIKE_NATIVE (.*)/)
      expect(m).toBeTruthy()
      const out = JSON.parse(m[1])
      expect(out.electron).toBeTruthy()
      expect(out.faiss).toMatchObject({ ok: true, search: [0] })
      expect(out.ort).toMatchObject({ ok: true, hasSession: true, tensor: true })
    },
    { timeout: 120000 }
  )
})
