import { beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  loadTokenizer,
  normalizeText,
  preTokenize,
  wordPiece
} from '../../electron/main/rag/tokenizer-bert'

// 合成词表：覆盖 CJK 单字、WordPiece 后缀、小写折叠、标点
const VOCAB = {
  '[PAD]': 0,
  '[UNK]': 1,
  '[CLS]': 2,
  '[SEP]': 3,
  为: 4,
  这: 5,
  个: 6,
  句: 7,
  子: 8,
  你: 9,
  好: 10,
  世: 11,
  界: 12,
  '，': 13,
  he: 14,
  '##llo': 15,
  world: 16,
  cafe: 17,
  ab: 18,
  '##c': 19
}

function writeTokenizerJson(dir, extra = {}) {
  fs.mkdirSync(dir, { recursive: true })
  const json = {
    version: '1.0',
    normalizer: {
      type: 'BertNormalizer',
      clean_text: true,
      handle_chinese_chars: true,
      strip_accents: null,
      lowercase: true
    },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    post_processor: { type: 'BertProcessing', sep: ['[SEP]', 3], cls: ['[CLS]', 2] },
    model: {
      type: 'WordPiece',
      unk_token: '[UNK]',
      continuing_subword_prefix: '##',
      max_input_chars_per_word: 100,
      vocab: VOCAB
    },
    ...extra
  }
  fs.writeFileSync(path.join(dir, 'tokenizer.json'), JSON.stringify(json))
  return dir
}

let dir
beforeEach(() => {
  dir = writeTokenizerJson(fs.mkdtempSync(path.join(os.tmpdir(), 'tok-')))
})

describe('wordPiece', () => {
  it('greedy longest match with ## prefix and [UNK] fallback', () => {
    expect(wordPiece('hello', VOCAB, 1)).toEqual([14, 15]) // he + ##llo
    expect(wordPiece('world', VOCAB, 1)).toEqual([16])
    expect(wordPiece('xyz', VOCAB, 1)).toEqual([1]) // 全部无法匹配 → [UNK]
    expect(wordPiece('abc', VOCAB, 1)).toEqual([18, 19])
    expect(wordPiece('a'.repeat(101), VOCAB, 1)).toEqual([1]) // 超长词直接 [UNK]
  })
})

describe('normalize + preTokenize', () => {
  it('CJK chars get isolated with spaces', () => {
    expect(preTokenize(normalizeText('你好，世界！'))).toEqual(['你', '好', '，', '世', '界', '！'])
  })
  it('lowercases and strips accents', () => {
    expect(normalizeText('Café HELLO')).toBe('cafe hello')
  })
  it('drops control chars and normalizes whitespace', () => {
    // \u0000 被丢弃，\u00a0 归一为普通空格
    expect(normalizeText('a\u0000b\u00a0c')).toBe('ab c')
  })
})

describe('loadTokenizer.encode', () => {
  it('encodes with [CLS]/[SEP] and synthetic vocab', () => {
    const tk = loadTokenizer(dir)
    expect(tk.vocabSize).toBe(Object.keys(VOCAB).length)
    const e = tk.encode('你好，world')
    expect(e.inputIds).toEqual([2, 9, 10, 13, 16, 3])
    expect(e.attentionMask).toEqual(e.inputIds.map(() => 1))
    expect(e.tokenTypeIds).toEqual(e.inputIds.map(() => 0))
  })
  it('wordpiece splits latin words', () => {
    const tk = loadTokenizer(dir)
    expect(tk.encode('hello').inputIds).toEqual([2, 14, 15, 3])
  })
  it('unknown words map to a single [UNK]', () => {
    const tk = loadTokenizer(dir)
    // 'xy' 作为一个整体词不在词表 → 一个 [UNK]
    expect(tk.encode('你好xy').inputIds).toEqual([2, 9, 10, 1, 3])
  })
  it('truncates to maxLength keeping specials', () => {
    const tk = loadTokenizer(dir)
    const e = tk.encode('你好世界你好世界', { maxLength: 6 })
    expect(e.inputIds).toEqual([2, 9, 10, 11, 12, 3])
  })
  it('rejects non-WordPiece tokenizer.json', () => {
    writeTokenizerJson(dir, { model: { type: 'BPE', vocab: {}, unk_token: '[UNK]' } })
    expect(() => loadTokenizer(dir)).toThrow(/不支持的分词器类型/)
  })
})
