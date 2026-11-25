// @vitest-environment jsdom
/* global document, MouseEvent */
import { afterEach, describe, expect, it } from 'vitest'
import {
  installController,
  sanitizeElementInfo,
  validateStyleChanges
} from '../../electron/main/browser/element-inspector'

const controllers = []
function createController() {
  const controller = installController(`__testInspector${controllers.length}`)
  controllers.push(controller)
  return controller
}

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose()
  document.body.innerHTML = ''
})

describe('browser element inspector', () => {
  it('validates style properties and rejects unsafe CSS values', () => {
    expect(
      validateStyleChanges({ WIDTH: '240px', opacity: '0.5', 'background-color': '#fff' }, [
        'width',
        'width'
      ])
    ).toEqual({
      styles: { width: '240px', opacity: '0.5', 'background-color': '#fff' },
      resetProperties: ['width']
    })

    expect(() => validateStyleChanges({ width: '1px;color:red' })).toThrow(/不安全/)
    expect(() => validateStyleChanges({ background: 'url(https://example.com)' })).toThrow(/不支持/)
    expect(() => validateStyleChanges({ opacity: '2' })).toThrow(/透明度/)
  })

  it('sanitizes selected element data before returning it to the renderer', () => {
    const selected = sanitizeElementInfo({
      elementId: 'el-abc123',
      tagName: 'BUTTON',
      id: 'go',
      className: 'primary',
      selector: '#go',
      text: 'x'.repeat(600),
      html: '<button>go</button>',
      href: 'https://example.com/',
      url: 'https://example.com/',
      title: 'Example',
      rect: { x: 1, y: 2, width: 80, height: 32 },
      styles: { width: '80px', unknown: 'ignored' },
      customStyles: { width: '100px', unknown: 'ignored' },
      extra: 'ignored'
    })

    expect(selected).toMatchObject({
      elementId: 'el-abc123',
      tagName: 'button',
      selector: '#go',
      rect: { x: 1, y: 2, width: 80, height: 32 },
      styles: { width: '80px' },
      customStyles: { width: '100px' }
    })
    expect(selected.text).toHaveLength(500)
    expect(selected.extra).toBeUndefined()
    expect(sanitizeElementInfo({ elementId: '../bad', tagName: 'div' })).toBe(null)
  })

  it('blocks pointer and mouse defaults and selects on click without activating the target', async () => {
    document.body.innerHTML = '<button id="go">提交</button>'
    const button = document.querySelector('#go')
    let clicks = 0
    button.addEventListener('click', () => clicks++)
    const controller = createController()
    const resultPromise = new Promise((resolve) => controller.start(resolve, 5000))

    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'auxclick']) {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true })
      button.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    }
    expect(controller.isActive()).toBe(true)
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    expect(await resultPromise).toMatchObject({ selected: { tagName: 'button', id: 'go' } })
    expect(clicks).toBe(0)
  })

  it('keeps both waiters alive when a selection is re-armed', async () => {
    document.body.innerHTML = '<button id="go">Go</button>'
    const button = document.querySelector('#go')
    const controller = createController()
    const oldResult = new Promise((resolve) => controller.start(resolve, 5000))
    controller.arm(5000)
    expect(await oldResult).toEqual({ cancelled: true, reason: 'replaced' })

    const currentResult = controller.wait()
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(await currentResult).toMatchObject({ selected: { id: 'go' } })
  })

  it('redacts sensitive attributes regardless of quoting or whitespace', async () => {
    document.body.innerHTML =
      "<div><button data-token='private-token' value=private-value aria-label='go'>Go</button></div>"
    const button = document.querySelector('button')
    const controller = createController()
    const resultPromise = new Promise((resolve) => controller.start(resolve, 5000))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const { selected } = await resultPromise

    expect(selected.html).toContain('[redacted]')
    expect(selected.html).not.toContain('private-token')
    expect(selected.html).not.toContain('private-value')
  })

  it('restores live styles and removes the controller on navigation', async () => {
    document.body.innerHTML = '<button id="go" style="width: 80px">Go</button>'
    const button = document.querySelector('#go')
    const controller = createController()
    const resultPromise = new Promise((resolve) => controller.start(resolve, 5000))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    const { selected } = await resultPromise
    controller.setStyles(selected.elementId, { width: '240px' }, [])
    expect(button.style.width).toBe('240px')

    controller.dispose()
    expect(button.style.width).toBe('80px')
    expect(document.querySelector('[data-miniagent-inspector]')).toBe(null)
    expect(controller.getSelected()).toBe(null)
  })
})
