// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useComposerStore } from '../../../src/stores/composer'

let composer

beforeEach(() => {
  setActivePinia(createPinia())
  composer = useComposerStore()
})

describe('composer draft store', () => {
  it('appends browser context without discarding the existing draft', () => {
    composer.text = '已有草稿'
    composer.append('网页元素上下文')

    expect(composer.text).toBe('已有草稿\n\n网页元素上下文')
    expect(composer.focusRevision).toBe(1)
  })

  it('ignores blank context and clears after a successful send', () => {
    composer.append('   ')
    expect(composer.text).toBe('')
    composer.text = '待发送'
    composer.clear()
    expect(composer.text).toBe('')
  })

  it('merges sent content with input added while the request was in flight', () => {
    composer.text = '发送期间新增'
    composer.restoreSent('发送前内容')
    expect(composer.text).toBe('发送前内容\n\n发送期间新增')

    composer.clear()
    composer.restoreSent('发送前内容')
    expect(composer.text).toBe('发送前内容')
  })
})
