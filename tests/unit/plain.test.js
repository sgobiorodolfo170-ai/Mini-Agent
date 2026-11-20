import { describe, expect, it } from 'vitest'
import { reactive } from 'vue'

import { plain } from '../../src/common/plain'

describe('plain', () => {
  it('passes primitives through unchanged', () => {
    expect(plain(1)).toBe(1)
    expect(plain('x')).toBe('x')
    expect(plain(null)).toBe(null)
    expect(plain(undefined)).toBe(undefined)
    expect(plain(false)).toBe(false)
  })

  it('converts a reactive proxy into a plain clone-safe object', () => {
    const out = plain(reactive({ a: 1, b: { c: 2 } }))
    // contextBridge can only clone plain objects — no Proxy may leak through
    expect(out.constructor).toBe(Object)
    expect(out.b.constructor).toBe(Object)
    expect(out).toEqual({ a: 1, b: { c: 2 } })
  })

  it('deep-converts nested arrays and objects', () => {
    const out = plain(reactive({ list: [{ id: 1 }, { id: 2 }], meta: { tags: ['a', 'b'] } }))
    expect(out.list.constructor).toBe(Array)
    expect(out.list[0].constructor).toBe(Object)
    expect(out.meta.tags).toEqual(['a', 'b'])
    expect(JSON.parse(JSON.stringify(out))).toEqual({
      list: [{ id: 1 }, { id: 2 }],
      meta: { tags: ['a', 'b'] }
    })
  })

  it('keeps plain (non-reactive) objects structurally equal', () => {
    const src = { name: 'x', opts: { deep: true } }
    expect(plain(src)).toEqual(src)
  })

  it('survives a full structuredClone round trip like contextBridge would', () => {
    const out = plain(reactive({ conv: { id: 'c1', pinned: false }, tags: ['a'] }))
    // contextBridge serializes via structured-clone semantics — output must survive it
    expect(structuredClone(out)).toEqual({ conv: { id: 'c1', pinned: false }, tags: ['a'] })
  })
})
