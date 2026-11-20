const fs = require('fs')
const path = require('path')

// BERT WordPiece 分词器的最小纯 JS 实现（无原生依赖）：
// 对齐 HuggingFace BertNormalizer / BertPreTokenizer / WordPiece 行为，
// 仅依赖模型目录下的 tokenizer.json（BAAI/bge-* 与 Xenova/* 导出均为该格式）。
// BGE 系列为 BERT 架构：BertNormalizer(lowercase) + BertPreTokenizer + WordPiece + [CLS]/[SEP]。

// HF _is_chinese_char 的全部区段（含扩展区与兼容表意文字）。
function isChineseChar(cp) {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f)
  )
}

// ASCII 「标点」范围与 HF 一致（33-47/58-64/91-96/123-126），另加 Unicode P 类。
const PUNCT_RE = /[\p{P}\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E]/u
const CTRL_RE = /[\p{Cc}\p{Cf}\uFFFD]/u
const WS_RE = /\s/u

// BertNormalizer：clean_text + handle_chinese_chars + lowercase + strip_accents。
// stripAccents 传 null 时跟随 lowercase（与 HF 默认一致）。
function normalizeText(text, { lowercase = true, stripAccents = null } = {}) {
  const doStrip = stripAccents === null ? lowercase : stripAccents
  let out = ''
  for (const ch of text) {
    if (WS_RE.test(ch)) {
      out += ' '
      continue
    }
    if (CTRL_RE.test(ch)) continue
    const cp = ch.codePointAt(0)
    if (isChineseChar(cp)) {
      out += ` ${ch} `
      continue
    }
    let c = lowercase ? ch.toLowerCase() : ch
    if (doStrip && cp > 0x7e) c = c.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    out += c
  }
  return out
}

// BertPreTokenizer：按空白切词，标点逐字符独立成词（CJK 已在归一化时用空格隔开）。
function preTokenize(text) {
  const tokens = []
  let word = ''
  const flush = () => {
    if (word) {
      tokens.push(word)
      word = ''
    }
  }
  for (const ch of text) {
    if (WS_RE.test(ch)) {
      flush()
    } else if (PUNCT_RE.test(ch)) {
      flush()
      tokens.push(ch)
    } else {
      word += ch
    }
  }
  flush()
  return tokens
}

// WordPiece 贪心最长匹配：首段裸词，后续段带 ## 前缀；无法匹配 → [UNK]。
function wordPiece(token, vocab, unkId, { prefix = '##', maxChars = 100 } = {}) {
  if (token.length > maxChars) return [unkId]
  const ids = []
  let start = 0
  while (start < token.length) {
    let end = token.length
    let found = -1
    while (start < end) {
      let sub = token.slice(start, end)
      if (start > 0) sub = prefix + sub
      const id = vocab[sub]
      if (id !== undefined) {
        found = id
        break
      }
      end--
    }
    if (found === -1) return [unkId]
    ids.push(found)
    start = end
  }
  return ids
}

// 从模型目录加载 tokenizer.json 并返回编码器。
function loadTokenizer(modelDir, fsImpl = fs) {
  const raw = JSON.parse(fsImpl.readFileSync(path.join(modelDir, 'tokenizer.json'), 'utf8'))
  const model = raw.model || {}
  if (model.type && model.type !== 'WordPiece') {
    throw new Error(`不支持的分词器类型: ${model.type}（仅支持 WordPiece/BERT）`)
  }
  const vocab = model.vocab || {}
  const unkId = vocab[model.unk_token || '[UNK]']
  if (unkId === undefined) throw new Error('tokenizer.json 缺少 [UNK] 词元')
  const clsId = vocab['[CLS]']
  const sepId = vocab['[SEP]']
  const padId = vocab['[PAD]'] !== undefined ? vocab['[PAD]'] : 0
  if (clsId === undefined || sepId === undefined) {
    throw new Error('tokenizer.json 缺少 [CLS]/[SEP] 词元')
  }
  const norm = raw.normalizer || {}
  const normOpts = {
    lowercase: norm.lowercase !== false,
    stripAccents: norm.strip_accents === undefined ? null : norm.strip_accents
  }

  function encode(text, { maxLength = 512 } = {}) {
    const pieces = preTokenize(normalizeText(String(text || ''), normOpts))
    let ids = []
    for (const p of pieces) ids.push(...wordPiece(p, vocab, unkId))
    // [CLS] ... [SEP]，超长时保留特殊词元（BertProcessing 语义）
    const budget = maxLength - 2
    if (ids.length > budget) ids = ids.slice(0, budget)
    ids = [clsId, ...ids, sepId]
    return {
      inputIds: ids,
      attentionMask: ids.map(() => 1),
      tokenTypeIds: ids.map(() => 0)
    }
  }

  return { vocabSize: Object.keys(vocab).length, clsId, sepId, padId, unkId, encode }
}

module.exports = { loadTokenizer, normalizeText, preTokenize, wordPiece, isChineseChar }
