const { loadTokenizer } = require('./tokenizer-bert')
const { onnxPath, packageDir } = require('./local-models')

// BGE v1.5 中文模型的查询侧指令（官方建议：短查询检索场景加前缀可显著提升召回）。
const QUERY_INSTRUCTION = '为这个句子生成表示以用于检索相关文章:'

function l2normalize(v) {
  let sum = 0
  for (let i = 0; i < v.length; i++) sum += v[i] * v[i]
  const d = Math.sqrt(sum)
  if (!d) return v
  for (let i = 0; i < v.length; i++) v[i] = v[i] / d
  return v
}

// CLS 池化：取每个样本第 0 个 token 的隐向量（BGE 标准用法）。
function poolCls(data, batchSize, seqLen, hidden) {
  const out = []
  for (let i = 0; i < batchSize; i++) {
    const start = i * seqLen * hidden
    const vec = new Float32Array(hidden)
    for (let j = 0; j < hidden; j++) vec[j] = data[start + j]
    out.push(vec)
  }
  return out
}

// 把一批编码结果 pad 成同长并构建 ORT 输入（BERT int64）。
function buildFeeds(encodings, padId, inputNames, ortImpl) {
  const seqLen = Math.max(...encodings.map((e) => e.inputIds.length))
  const batch = encodings.length
  const ids = new BigInt64Array(batch * seqLen)
  const mask = new BigInt64Array(batch * seqLen)
  const types = new BigInt64Array(batch * seqLen)
  encodings.forEach((e, i) => {
    const off = i * seqLen
    for (let j = 0; j < seqLen; j++) {
      const on = j < e.inputIds.length
      ids[off + j] = BigInt(on ? e.inputIds[j] : padId)
      mask[off + j] = BigInt(on ? 1 : 0)
      types[off + j] = 0n
    }
  })
  const feeds = {
    input_ids: new ortImpl.Tensor('int64', ids, [batch, seqLen]),
    attention_mask: new ortImpl.Tensor('int64', mask, [batch, seqLen])
  }
  if (inputNames.includes('token_type_ids')) {
    feeds.token_type_ids = new ortImpl.Tensor('int64', types, [batch, seqLen])
  }
  return feeds
}

// 核心推理：session 与 tokenizer 均注入，方便单测。
async function embedWithSession({
  session,
  tokenizer,
  texts,
  queryMode = false,
  batchSize = 8,
  maxLength = 512,
  ortImpl,
  instruction = QUERY_INSTRUCTION
}) {
  if (!texts.length) return { vectors: [], dim: 0 }
  const outputName = session.outputNames.includes('sentence_embedding')
    ? 'sentence_embedding'
    : session.outputNames.includes('last_hidden_state')
      ? 'last_hidden_state'
      : session.outputNames[0]
  const vectors = []
  let dim = 0
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts
      .slice(i, i + batchSize)
      .map((t) => tokenizer.encode(queryMode ? `${instruction}${t}` : t, { maxLength }))
    const feeds = buildFeeds(batch, tokenizer.padId, session.inputNames, ortImpl)
    const res = await session.run(feeds)
    const t = res[outputName]
    const [b, s, h] = t.dims.length === 3 ? t.dims : [t.dims[0], 1, t.dims[1]]
    if (outputName === 'last_hidden_state') {
      for (const vec of poolCls(t.data, b, s, h)) {
        if (!dim) dim = vec.length
        vectors.push(l2normalize(vec))
      }
    } else {
      for (let bi = 0; bi < b; bi++) {
        const vec = new Float32Array(h)
        for (let j = 0; j < h; j++) vec[j] = t.data[bi * h + j]
        if (!dim) dim = vec.length
        vectors.push(l2normalize(vec))
      }
    }
  }
  return { vectors, dim }
}

// 会话缓存：同一模型文件只创建一次 session（加载+图优化较慢）。
const sessions = new Map()

async function getSession(modelsRoot, pkg, ortImpl = require('onnxruntime-node')) {
  const key = pkg.id
  if (sessions.has(key)) return sessions.get(key)
  const modelFile = onnxPath(modelsRoot, pkg)
  const session = await ortImpl.InferenceSession.create(modelFile, {
    graphOptimizationLevel: 'all'
  })
  sessions.set(key, session)
  return session
}

function clearSessionCache() {
  sessions.clear()
}

// 高层入口：本地嵌入一批文本。queryMode 时自动加 BGE 查询指令前缀。
async function embedTextsLocal({ modelsRoot, pkg, texts, queryMode = false, batchSize = 8 }) {
  const ortImpl = require('onnxruntime-node')
  const session = await getSession(modelsRoot, pkg, ortImpl)
  const tokenizer = loadTokenizer(packageDir(modelsRoot, pkg))
  return embedWithSession({
    session,
    tokenizer,
    texts,
    queryMode,
    batchSize,
    ortImpl
  })
}

module.exports = {
  QUERY_INSTRUCTION,
  l2normalize,
  poolCls,
  buildFeeds,
  embedWithSession,
  getSession,
  clearSessionCache,
  embedTextsLocal
}
