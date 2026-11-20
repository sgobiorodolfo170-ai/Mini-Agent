// 一次性端到端验证：真实 BGE 模型 × 手写 WordPiece 分词器 × onnxruntime-node × faiss-node。
// 用法：node scripts/spike-local-embed.js [--root .tmp-spike-models] [--model bge-small-zh-v1.5:int8]
const path = require('path')
const localModels = require('../electron/main/rag/local-models')
const { embedTextsLocal } = require('../electron/main/rag/embed-local')
const faissIndex = require('../electron/main/rag/faiss-index')

const args = process.argv.slice(2)
function argOf(name, dflt) {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : dflt
}
const root = path.resolve(process.cwd(), argOf('--root', '.tmp-spike-models'))
const pkgId = argOf('--model', 'bge-small-zh-v1.5:int8')

async function main() {
  const pkg = localModels.getPackage(pkgId)
  if (!pkg) throw new Error('未知模型包: ' + pkgId)
  if (!localModels.isDownloaded(root, pkg)) {
    console.log('downloading', pkgId, '...')
    await localModels.downloadPackage(root, pkg, {
      onProgress: (p) =>
        p.totalBytes &&
        console.log(
          `  ${p.file}: ${(p.received / 1e6).toFixed(1)}MB / ${(p.totalBytes / 1e6).toFixed(1)}MB`
        )
    })
  }

  // 检索场景：query + 三个主题明显不同的 chunk
  const chunks = [
    '公司报销流程：员工提交发票后需直属主管审批，再交由财务复核，三个工作日内完成打款。',
    '明天天气晴朗，最高气温 31 摄氏度，适合外出郊游。',
    '篮球比赛中，三分球是最直观的得分手段之一。'
  ]
  const texts = chunks.map((t) => t)
  const docRes = await embedTextsLocal({ modelsRoot: root, pkg, texts })
  const qRes = await embedTextsLocal({
    modelsRoot: root,
    pkg,
    texts: ['报销要怎么走流程？'],
    queryMode: true
  })

  const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0)
  console.log('dim =', docRes.dim, 'chunks =', docRes.vectors.length)
  const q = qRes.vectors[0]
  console.log('query norm ≈', Math.hypot(...q.slice(0, 8)))
  const sims = docRes.vectors
    .map((v, i) => ({ i, score: dot(q, v) }))
    .sort((a, b) => b.score - a.score)
  for (const s of sims)
    console.log(`  chunk${s.i} score=${s.score.toFixed(4)} :: ${chunks[s.i].slice(0, 18)}…`)

  // faiss 检索一致性（归一化内积 = 余弦）
  const faiss = faissIndex.loadFaiss()
  const idx = new faiss.IndexFlatIP(docRes.dim)
  const flat = []
  docRes.vectors.forEach((v) => flat.push(...Array.from(v)))
  idx.add(flat)
  const r = idx.search(Array.from(q), 1)
  console.log('faiss top chunk =', r.labels[0], 'score =', r.distances[0].toFixed(4))

  const ok =
    docRes.dim === pkg.dim &&
    sims[0].i === 0 &&
    sims[0].score > 0.5 &&
    sims[1].score < sims[0].score - 0.1
  console.log(ok ? 'SPIKE_EMBED_OK' : 'SPIKE_EMBED_FAIL')
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error('SPIKE_EMBED_ERROR', e)
  process.exit(1)
})
