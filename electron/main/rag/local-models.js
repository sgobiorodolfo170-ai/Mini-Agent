const fs = require('fs')
const path = require('path')
const { isShuttingDown } = require('../lifecycle')

// 本地嵌入模型包：BGE 中文 v1.5 系列 ONNX 导出（Xenova 仓库），量化/非量化各一。
// 一键下载到 userData/models/<id>/，每包只需 model.onnx + tokenizer.json + config.json。
const DEFAULT_MIRROR = 'https://hf-mirror.com'
const REPO_PREFIX = 'Xenova'

// id: `${model}:${quant}`；quant: fp32（精度优先）/ int8（量化，约 1/4 体积）
const CATALOG = [
  {
    id: 'bge-small-zh-v1.5:fp32',
    model: 'bge-small-zh-v1.5',
    quant: 'fp32',
    dim: 512,
    repo: 'bge-small-zh-v1.5',
    sizeHint: '约 90 MB',
    files: ['onnx/model.onnx', 'tokenizer.json', 'config.json']
  },
  {
    id: 'bge-small-zh-v1.5:int8',
    model: 'bge-small-zh-v1.5',
    quant: 'int8',
    dim: 512,
    repo: 'bge-small-zh-v1.5',
    sizeHint: '约 22 MB',
    files: ['onnx/model_quantized.onnx', 'tokenizer.json', 'config.json']
  },
  {
    id: 'bge-base-zh-v1.5:fp32',
    model: 'bge-base-zh-v1.5',
    quant: 'fp32',
    dim: 768,
    repo: 'bge-base-zh-v1.5',
    sizeHint: '约 388 MB',
    files: ['onnx/model.onnx', 'tokenizer.json', 'config.json']
  },
  {
    id: 'bge-base-zh-v1.5:int8',
    model: 'bge-base-zh-v1.5',
    quant: 'int8',
    dim: 768,
    repo: 'bge-base-zh-v1.5',
    sizeHint: '约 98 MB',
    files: ['onnx/model_quantized.onnx', 'tokenizer.json', 'config.json']
  }
]

function getPackage(id) {
  return CATALOG.find((p) => p.id === id) || null
}

function packageDir(modelsRoot, pkg) {
  return path.join(modelsRoot, `${pkg.model}-${pkg.quant}`)
}

// 包是否已完整下载（三个文件都存在且 model.onnx 大于 1MB 防止半截文件误判）。
function isDownloaded(modelsRoot, pkg, fsImpl = fs) {
  const dir = packageDir(modelsRoot, pkg)
  const modelFile = pkg.quant === 'int8' ? 'onnx/model_quantized.onnx' : 'onnx/model.onnx'
  for (const f of pkg.files) {
    if (!fsImpl.existsSync(path.join(dir, f.replace('onnx/', '')))) return false
  }
  try {
    const st = fsImpl.statSync(path.join(dir, modelFile.replace('onnx/', '')))
    return st.size > 1024 * 1024
  } catch {
    return false
  }
}

function listPackages(modelsRoot, fsImpl = fs) {
  return CATALOG.map((p) => {
    const downloaded = isDownloaded(modelsRoot, p, fsImpl)
    let sizeBytes = 0
    if (downloaded) {
      const dir = packageDir(modelsRoot, p)
      for (const f of p.files) {
        try {
          sizeBytes += fsImpl.statSync(path.join(dir, f.replace('onnx/', ''))).size
        } catch {
          /* 忽略统计失败 */
        }
      }
    }
    return {
      id: p.id,
      model: p.model,
      quant: p.quant,
      dim: p.dim,
      sizeHint: p.sizeHint,
      sizeBytes,
      dir: packageDir(modelsRoot, p),
      downloaded
    }
  })
}

function onnxPath(modelsRoot, pkg) {
  const name = pkg.quant === 'int8' ? 'model_quantized.onnx' : 'model.onnx'
  return path.join(packageDir(modelsRoot, pkg), name)
}

// 下载单个文件（跟随重定向），onProgress(received, total) 增量回调；先写 .part 再原子改名。
async function downloadFile(
  url,
  dest,
  { onProgress = () => {}, fetchImpl = globalThis.fetch } = {}
) {
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60000) })
  if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}: ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  const tmp = `${dest}.part`
  const out = fs.createWriteStream(tmp)
  let received = 0
  for await (const chunk of res.body) {
    received += chunk.length
    if (!out.write(chunk)) {
      await new Promise((r) => out.once('drain', r))
    }
    onProgress(received, total)
  }
  await new Promise((r, j) => {
    out.end(r)
    out.on('error', j)
  })
  fs.renameSync(tmp, dest)
  return { received, total }
}

// 下载一个模型包（幂等：文件已存在则跳过）。mirror 可覆盖（默认 hf-mirror.com）。
async function downloadPackage(
  modelsRoot,
  pkg,
  { mirror = DEFAULT_MIRROR, onProgress = () => {}, fetchImpl = globalThis.fetch, fsImpl = fs } = {}
) {
  const dir = packageDir(modelsRoot, pkg)
  fsImpl.mkdirSync(dir, { recursive: true })
  const total = pkg.files.length
  let done = 0
  for (const rel of pkg.files) {
    if (isShuttingDown()) return { id: pkg.id, dir, aborted: true }
    const dest = path.join(dir, rel.replace('onnx/', ''))
    if (fsImpl.existsSync(dest)) {
      done++
      onProgress({ file: rel, done, total, received: 0, totalBytes: 0 })
      continue
    }
    const url = `${mirror.replace(/\/+$/, '')}/${REPO_PREFIX}/${pkg.repo}/resolve/main/${rel}`
    await downloadFile(url, dest, {
      fetchImpl,
      onProgress: (received, totalBytes) =>
        onProgress({ file: rel, done, total, received, totalBytes })
    })
    done++
    onProgress({ file: rel, done, total, received: 0, totalBytes: 0 })
  }
  return { id: pkg.id, dir }
}

// 删除本地模型包目录。
function deletePackage(modelsRoot, pkg, fsImpl = fs) {
  const dir = packageDir(modelsRoot, pkg)
  fsImpl.rmSync(dir, { recursive: true, force: true })
  return true
}

module.exports = {
  CATALOG,
  DEFAULT_MIRROR,
  REPO_PREFIX,
  getPackage,
  packageDir,
  isDownloaded,
  listPackages,
  onnxPath,
  downloadFile,
  downloadPackage,
  deletePackage
}
