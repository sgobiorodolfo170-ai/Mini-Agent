import { describe, expect, it } from 'vitest'
import {
  QUERY_INSTRUCTION,
  l2normalize,
  poolCls,
  buildFeeds,
  embedWithSession
} from '../../electron/main/rag/embed-local'

// 合成词表：指令与测试文本的每个字一个 token，便于断言
const CHARS = [...QUERY_INSTRUCTION, ...'你好世界甲乙丙']
const VOCAB = {}
;['[PAD]', '[UNK]', '[CLS]', '[SEP]', ...new Set(CHARS)].forEach((t, i) => {
  VOCAB[t] = i
})

// 直接构造与 loadTokenizer 返回结构一致的合成 tokenizer（不经文件）；
// 与真实 tokenizer 相同：输出带 [CLS]/[SEP] 特殊词元。
function synthTokenizer() {
  let next = 100
  const encode = (text) => {
    const ids = [...text].map((ch) => (VOCAB[ch] !== undefined ? VOCAB[ch] : next++))
    const full = [2, ...ids, 3]
    return { inputIds: full, attentionMask: full.map(() => 1), tokenTypeIds: full.map(() => 0) }
  }
  return { vocabSize: 100, clsId: 2, sepId: 3, padId: 0, unkId: 1, encode }
}

// 假 ORT：Tensor 只做数据容器
class FakeTensor {
  constructor(type, data, dims) {
    this.type = type
    this.data = data
    this.dims = dims
  }
}
const fakeOrt = { Tensor: FakeTensor }

// 假 session：输出 last_hidden_state，每个位置的隐向量 = [token_id, 1, 0, 0]，
// CLS 池化后可精确断言。
function fakeSession(hidden = 4) {
  return {
    inputNames: ['input_ids', 'attention_mask', 'token_type_ids'],
    outputNames: ['last_hidden_state'],
    async run(feeds) {
      const [b, s] = feeds.input_ids.dims
      const data = new Float32Array(b * s * hidden)
      for (let i = 0; i < b * s; i++) {
        data[i * hidden] = Number(feeds.input_ids.data[i])
        data[i * hidden + 1] = 1
      }
      return { last_hidden_state: new FakeTensor('float32', data, [b, s, hidden]) }
    }
  }
}

describe('l2normalize / poolCls', () => {
  it('normalizes to unit length', () => {
    const v = l2normalize(Float32Array.from([3, 4]))
    expect(v[0]).toBeCloseTo(0.6, 5)
    expect(v[1]).toBeCloseTo(0.8, 5)
  })
  it('pools first token of each sample', () => {
    const out = poolCls([9, 9, 8, 8, 7, 7, 6, 6], 2, 2, 2)
    expect([...out[0]]).toEqual([9, 9])
    expect([...out[1]]).toEqual([7, 7])
  })
})

describe('buildFeeds', () => {
  it('pads with padId, masks beyond length, includes token_type_ids', () => {
    const enc = [
      { inputIds: [2, 9, 3], attentionMask: [1, 1, 1], tokenTypeIds: [0, 0, 0] },
      {
        inputIds: [2, 10, 11, 12, 3],
        attentionMask: [1, 1, 1, 1, 1],
        tokenTypeIds: [0, 0, 0, 0, 0]
      }
    ]
    const feeds = buildFeeds(enc, 0, ['input_ids', 'attention_mask', 'token_type_ids'], fakeOrt)
    expect(feeds.input_ids.dims).toEqual([2, 5])
    expect([...feeds.input_ids.data.slice(0, 5)]).toEqual([2n, 9n, 3n, 0n, 0n]) // 第一条 pad 到 5
    expect([...feeds.attention_mask.data.slice(0, 5)]).toEqual([1n, 1n, 1n, 0n, 0n])
    expect(feeds.token_type_ids).toBeDefined()
    expect(feeds.input_ids.type).toBe('int64')
  })
  it('omits token_type_ids when model does not take it', () => {
    const enc = [{ inputIds: [2, 9, 3], attentionMask: [1, 1, 1], tokenTypeIds: [0, 0, 0] }]
    const feeds = buildFeeds(enc, 0, ['input_ids', 'attention_mask'], fakeOrt)
    expect(feeds.token_type_ids).toBeUndefined()
  })
})

describe('embedWithSession', () => {
  it('CLS pooling + L2 normalize, dim from hidden size', async () => {
    const r = await embedWithSession({
      session: fakeSession(4),
      tokenizer: synthTokenizer(),
      texts: ['你好'],
      ortImpl: fakeOrt,
      instruction: '为'
    })
    expect(r.vectors).toHaveLength(1)
    expect(r.dim).toBe(4)
    // CLS token id = 2 → CLS 隐向量 [2,1,0,0]，归一化后首两个分量
    const norm = Math.sqrt(2 * 2 + 1)
    expect(r.vectors[0][0]).toBeCloseTo(2 / norm, 5)
    expect(r.vectors[0][1]).toBeCloseTo(1 / norm, 5)
  })
  it('queryMode prepends the instruction into the sequence', async () => {
    const tk = synthTokenizer()
    const direct = tk.encode('你好').inputIds.length
    const withIns = tk.encode('为你好').inputIds.length
    expect(withIns).toBe(direct + 1)
    // queryMode 下喂给 session 的序列应包含指令：用 runs 捕获验证
    let captured = null
    const session = fakeSession(4)
    const orig = session.run.bind(session)
    session.run = async (feeds) => {
      captured = feeds
      return orig(feeds)
    }
    await embedWithSession({
      session,
      tokenizer: tk,
      texts: ['你好'],
      queryMode: true,
      ortImpl: fakeOrt,
      instruction: '为'
    })
    // 捕获的 input_ids 第一个 batch 序列应包含 '为' 的 token id 且序列更长
    const ids = [...captured.input_ids.data]
    expect(ids.length).toBeGreaterThan(tk.encode('你好').inputIds.length)
    expect(ids).toContain(BigInt(VOCAB['为']))
  })
  it('batches by batchSize', async () => {
    let calls = 0
    const session = fakeSession(4)
    const orig = session.run.bind(session)
    session.run = async (feeds) => {
      calls++
      return orig(feeds)
    }
    const r = await embedWithSession({
      session,
      tokenizer: synthTokenizer(),
      texts: ['甲', '乙', '丙'],
      batchSize: 2,
      ortImpl: fakeOrt,
      instruction: '为'
    })
    expect(r.vectors).toHaveLength(3)
    expect(calls).toBe(2) // 2 + 1
  })
  it('empty input returns empty', async () => {
    const r = await embedWithSession({
      session: fakeSession(4),
      tokenizer: synthTokenizer(),
      texts: [],
      ortImpl: fakeOrt
    })
    expect(r.vectors).toEqual([])
    expect(r.dim).toBe(0)
  })
  it('prefers sentence_embedding output when present', async () => {
    const session = {
      inputNames: ['input_ids', 'attention_mask'],
      outputNames: ['sentence_embedding', 'last_hidden_state'],
      async run(feeds) {
        const [b] = feeds.input_ids.dims
        return {
          sentence_embedding: new FakeTensor('float32', new Float32Array(b * 3).fill(1), [b, 3])
        }
      }
    }
    const r = await embedWithSession({
      session,
      tokenizer: synthTokenizer(),
      texts: ['你好'],
      ortImpl: fakeOrt,
      instruction: '为'
    })
    expect(r.dim).toBe(3)
    expect(r.vectors[0][0]).toBeCloseTo(1 / Math.sqrt(3), 5)
  })
})
