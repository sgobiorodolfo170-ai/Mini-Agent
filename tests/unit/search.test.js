import { describe, expect, it } from 'vitest'
import { cosine, topK } from '../../electron/main/rag/search'

describe('cosine', () => {
  it('identical vectors score 1', () => {
    const a = Float32Array.from([0.2, 0.4, 0.6])
    expect(cosine(a, a)).toBeCloseTo(1, 5)
  })
  it('orthogonal vectors score 0', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1]))).toBeCloseTo(0, 6)
  })
  it('opposite vectors score -1', () => {
    expect(cosine(Float32Array.from([1, 0]), Float32Array.from([-1, 0]))).toBeCloseTo(-1, 5)
  })
})

describe('topK', () => {
  const q = Float32Array.from([1, 0])
  const rows = [
    { chunkId: 'near', vector: Float32Array.from([0.9, 0.1]) },
    { chunkId: 'far', vector: Float32Array.from([0.1, 0.9]) },
    { chunkId: 'mid', vector: Float32Array.from([0.5, 0.5]) },
    { chunkId: 'baddim', vector: Float32Array.from([1, 0, 0]) }
  ]
  it('returns top-k sorted by score and skips dim mismatch', () => {
    const out = topK(q, rows, { k: 3, minScore: 0 })
    expect(out.map((x) => x.chunkId)).toEqual(['near', 'mid', 'far'])
    expect(out.every((x) => x.chunkId !== 'baddim')).toBe(true)
  })
  it('respects minScore', () => {
    const out = topK(q, rows, { k: 3, minScore: 0.8 })
    expect(out.map((x) => x.chunkId)).toEqual(['near'])
  })
})
