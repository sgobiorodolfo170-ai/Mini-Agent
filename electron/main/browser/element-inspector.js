/* global window, document, CSS, getComputedStyle, location, requestAnimationFrame, cancelAnimationFrame */
const CONTROLLER_KEY = '__miniAgentElementInspectorV1'

const STYLE_PROPERTIES = new Set([
  'display',
  'position',
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'margin',
  'padding',
  'gap',
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'border-width',
  'border-style',
  'border-color',
  'border-radius',
  'opacity',
  'overflow',
  'object-fit'
])

const COMPUTED_PROPERTIES = [
  'display',
  'position',
  'width',
  'height',
  'margin',
  'padding',
  'gap',
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'line-height',
  'letter-spacing',
  'text-align',
  'border-width',
  'border-style',
  'border-color',
  'border-radius',
  'opacity',
  'overflow',
  'object-fit'
]

function validateStyleChanges(styles = {}, resetProperties = []) {
  if (!styles || typeof styles !== 'object' || Array.isArray(styles)) {
    throw new TypeError('样式必须是对象')
  }
  const entries = Object.entries(styles)
  if (entries.length > STYLE_PROPERTIES.size) throw new TypeError('样式属性过多')
  const clean = {}
  for (const [rawProperty, rawValue] of entries) {
    const property = String(rawProperty).trim().toLowerCase()
    if (!STYLE_PROPERTIES.has(property)) throw new TypeError(`不支持的 CSS 属性：${property}`)
    const value = String(rawValue == null ? '' : rawValue).trim()
    if (!value || value.length > 200) throw new TypeError(`CSS 属性值无效：${property}`)
    if (/[;{}<>\\]|\burl\s*\(|\bexpression\s*\(|javascript\s*:/i.test(value)) {
      throw new TypeError(`CSS 属性值包含不安全内容：${property}`)
    }
    if (property === 'opacity') {
      const opacity = Number(value)
      if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1)
        throw new TypeError('透明度必须在 0 到 1 之间')
    }
    clean[property] = value
  }
  if (!Array.isArray(resetProperties) || resetProperties.length > STYLE_PROPERTIES.size)
    throw new TypeError('重置属性列表无效')
  const reset = [...new Set(resetProperties.map((item) => String(item).trim().toLowerCase()))]
  for (const property of reset) {
    if (!STYLE_PROPERTIES.has(property)) throw new TypeError(`不支持的 CSS 属性：${property}`)
  }
  return { styles: clean, resetProperties: reset }
}

function sanitizeElementInfo(value) {
  if (!value || typeof value !== 'object') return null
  const elementId = String(value.elementId || '')
  if (!/^el-[a-z0-9-]{6,80}$/i.test(elementId)) return null
  const tagName = String(value.tagName || '')
    .toLowerCase()
    .slice(0, 40)
  if (!tagName) return null
  const rect = value.rect && typeof value.rect === 'object' ? value.rect : {}
  const styles = {}
  for (const property of COMPUTED_PROPERTIES) {
    const style = value.styles && value.styles[property]
    if (style != null) styles[property] = String(style).slice(0, 200)
  }
  const customStyles = {}
  if (value.customStyles && typeof value.customStyles === 'object') {
    for (const [property, style] of Object.entries(value.customStyles)) {
      if (STYLE_PROPERTIES.has(property) && style != null)
        customStyles[property] = String(style).slice(0, 200)
    }
  }
  return {
    elementId,
    tagName,
    id: String(value.id || '').slice(0, 200),
    className: String(value.className || '').slice(0, 500),
    selector: String(value.selector || tagName).slice(0, 1000),
    text: String(value.text || '').slice(0, 500),
    html: String(value.html || '').slice(0, 4000),
    href: String(value.href || '').slice(0, 2000),
    url: String(value.url || '').slice(0, 2000),
    title: String(value.title || '').slice(0, 500),
    rect: {
      x: Number(rect.x) || 0,
      y: Number(rect.y) || 0,
      width: Number(rect.width) || 0,
      height: Number(rect.height) || 0
    },
    styles,
    customStyles
  }
}

function installController(key) {
  if (window[key] && typeof window[key].start === 'function') return window[key]

  const elements = new Map()
  let sequence = 0
  let selectedId = null
  let active = false
  let pending = null
  let idleResult = null
  let frame = 0
  let target = null
  const listeners = []

  const host = document.createElement('div')
  host.setAttribute('data-miniagent-inspector', '')
  host.style.cssText =
    'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:none;'
  const shadow = host.attachShadow({ mode: 'open' })
  const box = document.createElement('div')
  box.style.cssText =
    'all:initial;position:fixed;border:2px solid #2563eb;background:rgba(37,99,235,.12);pointer-events:none;'
  const label = document.createElement('div')
  label.style.cssText =
    'all:initial;position:fixed;left:0;top:0;padding:3px 7px;border-radius:4px;background:#2563eb;color:#fff;font:12px/1.4 system-ui,sans-serif;white-space:nowrap;pointer-events:none;'
  shadow.append(box, label)
  ;(document.documentElement || document.body).appendChild(host)

  function selectorFor(element) {
    if (!element || element.nodeType !== 1) return ''
    if (element.id) return `#${CSS.escape(element.id)}`
    const parts = []
    let current = element
    while (current && current.nodeType === 1 && parts.length < 6) {
      let part = current.tagName.toLowerCase()
      if (current.id) {
        parts.unshift(`#${CSS.escape(current.id)}`)
        break
      }
      const parent = current.parentElement
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          (item) => item.tagName === current.tagName
        )
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`
      }
      parts.unshift(part)
      current = parent
    }
    return parts.join(' > ')
  }

  function readableText(element) {
    const tag = element.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return [element.getAttribute('aria-label'), element.getAttribute('placeholder'), element.name]
        .filter(Boolean)
        .join(' ')
        .slice(0, 240)
    }
    return String(element.innerText || element.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 240)
  }

  function safeHtml(element) {
    const tag = element.tagName.toLowerCase()
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return ''
    const clone = element.cloneNode(true)
    for (const node of [clone, ...clone.querySelectorAll('*')]) {
      for (const attribute of [...node.attributes]) {
        if (/(?:^value$|password|secret|token|credential|authorization)/i.test(attribute.name)) {
          node.setAttribute(attribute.name, '[redacted]')
        }
      }
    }
    return String(clone.outerHTML || '').slice(0, 4000)
  }

  function describe(element) {
    pruneElements()
    let record = elements.get(element)
    if (!record) {
      const id = `el-${Date.now().toString(36)}-${(++sequence).toString(36)}`
      record = { id, element, original: new Map(), applied: new Map() }
      elements.set(element, record)
    }
    const computed = getComputedStyle(element)
    const styles = {}
    for (const property of [
      'display',
      'position',
      'width',
      'height',
      'margin',
      'padding',
      'gap',
      'color',
      'background-color',
      'font-size',
      'font-weight',
      'line-height',
      'letter-spacing',
      'text-align',
      'border-width',
      'border-style',
      'border-color',
      'border-radius',
      'opacity',
      'overflow',
      'object-fit'
    ]) {
      styles[property] = computed.getPropertyValue(property)
    }
    const rect = element.getBoundingClientRect()
    return {
      elementId: record.id,
      tagName: element.tagName.toLowerCase(),
      id: element.id || '',
      className: String(element.className || '').slice(0, 500),
      selector: selectorFor(element),
      text: readableText(element),
      html: safeHtml(element),
      href: element.getAttribute('href') || '',
      url: location.href,
      title: document.title,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      styles,
      customStyles: Object.fromEntries(record.applied)
    }
  }

  function positionBox(element) {
    if (!element || !element.isConnected) {
      host.style.display = 'none'
      return
    }
    const rect = element.getBoundingClientRect()
    if (!rect.width && !rect.height) {
      host.style.display = 'none'
      return
    }
    host.style.display = 'block'
    box.style.left = `${Math.round(rect.left)}px`
    box.style.top = `${Math.round(rect.top)}px`
    box.style.width = `${Math.round(rect.width)}px`
    box.style.height = `${Math.round(rect.height)}px`
    label.textContent = `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ''}`
    label.style.left = `${Math.max(0, Math.round(rect.left))}px`
    label.style.top = `${Math.max(0, Math.round(rect.top) - 24)}px`
  }

  function removeListeners() {
    for (const [node, type, handler, options] of listeners) {
      node.removeEventListener(type, handler, options)
    }
    listeners.length = 0
  }

  function finish(result) {
    if (!pending) return
    const resolve = pending.resolve
    clearTimeout(pending.timer)
    pending = null
    active = false
    removeListeners()
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    if (result && result.selected) {
      selectedId = result.selected.elementId
      const selected = [...elements.values()].find((item) => item.id === selectedId)
      positionBox(selected ? selected.element : target)
    } else {
      host.style.display = 'none'
    }
    if (resolve) resolve(result)
    else idleResult = result
  }

  function pickTarget(event) {
    const found = event.composedPath().find((item) => item && item.nodeType === 1)
    return found && found !== host ? found : null
  }

  function onMove(event) {
    if (!active) return
    target = pickTarget(event)
    if (frame) return
    frame = requestAnimationFrame(() => {
      frame = 0
      positionBox(target)
    })
  }

  function onDown(event) {
    if (!active) return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  function onClick(event) {
    if (!active) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const element = pickTarget(event)
    if (!element) return
    finish({ selected: describe(element) })
  }

  function onKey(event) {
    if (active && event.key === 'Escape') {
      event.preventDefault()
      event.stopImmediatePropagation()
      finish({ cancelled: true, reason: 'cancelled' })
    }
  }

  function onReflow() {
    pruneElements()
    const selected = selectedId
      ? [...elements.values()].find((item) => item.id === selectedId)
      : null
    positionBox(selected ? selected.element : target)
  }

  function pruneElements() {
    for (const [element, record] of elements) {
      if (element.isConnected) continue
      restore(record)
      elements.delete(element)
    }
    if (selectedId && ![...elements.values()].some((item) => item.id === selectedId)) {
      selectedId = null
      host.style.display = 'none'
    }
  }

  function restore(record) {
    for (const [property, original] of record.original) {
      if (original.value)
        record.element.style.setProperty(property, original.value, original.priority)
      else record.element.style.removeProperty(property)
    }
    record.original.clear()
    record.applied.clear()
  }

  function dispose() {
    finish({ cancelled: true, reason: 'disposed' })
    removeListeners()
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    for (const record of elements.values()) restore(record)
    elements.clear()
    selectedId = null
    target = null
    idleResult = null
    host.remove()
    if (window[key] === controller) delete window[key]
  }

  function arm(timeoutMs) {
    if (pending) finish({ cancelled: true, reason: 'replaced' })
    active = true
    idleResult = null
    target = null
    host.style.display = 'none'
    const timer = setTimeout(() => finish({ cancelled: true, reason: 'timeout' }), timeoutMs)
    const state = { resolve: null, timer, result: null }
    state.result = new Promise((resolve) => {
      state.resolve = resolve
    })
    pending = state
    listeners.push(
      [document, 'pointermove', onMove, true],
      [document, 'pointerdown', onDown, true],
      [document, 'mousedown', onDown, true],
      [document, 'pointerup', onDown, true],
      [document, 'mouseup', onDown, true],
      [document, 'auxclick', onDown, true],
      [document, 'click', onClick, true],
      [document, 'contextmenu', onClick, true],
      [document, 'keydown', onKey, true],
      [window, 'scroll', onReflow, true],
      [window, 'resize', onReflow]
    )
    for (const [node, type, handler, options] of listeners) {
      node.addEventListener(type, handler, options)
    }
    return true
  }

  function wait() {
    if (idleResult) {
      const result = idleResult
      idleResult = null
      return Promise.resolve(result)
    }
    if (pending) return pending.result
    return Promise.resolve({ cancelled: true, reason: 'not-active' })
  }

  function start(resolve, timeoutMs) {
    arm(timeoutMs)
    if (pending) pending.result.then(resolve)
    else {
      const result = idleResult || { cancelled: true, reason: 'not-active' }
      idleResult = null
      resolve(result)
    }
  }

  function isActive() {
    return active
  }

  function cancel(reason = 'cancelled') {
    if (pending) finish({ cancelled: true, reason })
    else host.style.display = 'none'
  }

  function getSelected() {
    pruneElements()
    const record = [...elements.values()].find((item) => item.id === selectedId)
    if (!record || !record.element.isConnected) {
      selectedId = null
      host.style.display = 'none'
      return null
    }
    const info = describe(record.element)
    positionBox(record.element)
    return info
  }

  function setStyles(elementId, styles, resetProperties) {
    pruneElements()
    const record = [...elements.values()].find((item) => item.id === elementId)
    if (!record || !record.element.isConnected) return { stale: true }
    for (const property of resetProperties) {
      const original = record.original.get(property)
      if (original) record.element.style.setProperty(property, original.value, original.priority)
      else record.element.style.removeProperty(property)
      record.original.delete(property)
      record.applied.delete(property)
    }
    for (const [property, value] of Object.entries(styles)) {
      if (!record.original.has(property)) {
        record.original.set(property, {
          value: record.element.style.getPropertyValue(property),
          priority: record.element.style.getPropertyPriority(property)
        })
      }
      record.element.style.setProperty(property, value)
      record.applied.set(property, value)
    }
    selectedId = record.id
    const info = describe(record.element)
    positionBox(record.element)
    return info
  }

  function resetStyles(elementId) {
    pruneElements()
    const record = [...elements.values()].find((item) => item.id === elementId)
    if (!record || !record.element.isConnected) return { stale: true }
    for (const [property, original] of record.original) {
      if (original.value)
        record.element.style.setProperty(property, original.value, original.priority)
      else record.element.style.removeProperty(property)
    }
    record.original.clear()
    record.applied.clear()
    const info = describe(record.element)
    positionBox(record.element)
    return info
  }

  const controller = {
    start,
    arm,
    wait,
    isActive,
    cancel,
    getSelected,
    setStyles,
    resetStyles,
    dispose
  }
  Object.defineProperty(window, key, { value: controller, configurable: true })
  return controller
}

async function beginElementSelection(webContents, timeoutMs = 30000) {
  const timeout = Math.max(5000, Math.min(60000, Number(timeoutMs) || 30000))
  await webContents.executeJavaScript(
    `(() => { (${installController.toString()})(${JSON.stringify(CONTROLLER_KEY)}); return null; })()`
  )
  await webContents.executeJavaScript(`window[${JSON.stringify(CONTROLLER_KEY)}].arm(${timeout})`)
  return {
    result: webContents.executeJavaScript(`window[${JSON.stringify(CONTROLLER_KEY)}].wait()`)
  }
}

async function cancelElementSelection(webContents) {
  try {
    await webContents.executeJavaScript(
      `(() => { const controller = window[${JSON.stringify(CONTROLLER_KEY)}]; if (controller) controller.cancel(); })()`
    )
  } catch {
    // 页面正在导航或已经退出
  }
}

async function resetElementInspector(webContents) {
  try {
    await webContents.executeJavaScript(
      `(() => { const controller = window[${JSON.stringify(CONTROLLER_KEY)}]; if (controller) { controller.cancel(); controller.dispose(); } })()`
    )
  } catch {
    // 页面正在导航或已经退出
  }
}

async function getSelectedElement(webContents) {
  const value = await webContents.executeJavaScript(
    `(() => { const controller = window[${JSON.stringify(CONTROLLER_KEY)}]; return controller ? controller.getSelected() : null; })()`
  )
  return sanitizeElementInfo(value)
}

async function setSelectedElementStyles(webContents, elementId, changes) {
  const value = await webContents.executeJavaScript(
    `(() => {
      const controller = window[${JSON.stringify(CONTROLLER_KEY)}];
      if (!controller) return { stale: true };
      return controller.setStyles(
        ${JSON.stringify(elementId)},
        ${JSON.stringify(changes.styles)},
        ${JSON.stringify(changes.resetProperties)}
      );
    })()`
  )
  if (value && value.stale) return null
  return sanitizeElementInfo(value)
}

async function resetSelectedElementStyles(webContents, elementId) {
  const value = await webContents.executeJavaScript(
    `(() => {
      const controller = window[${JSON.stringify(CONTROLLER_KEY)}];
      if (!controller) return { stale: true };
      return controller.resetStyles(${JSON.stringify(elementId)});
    })()`
  )
  if (value && value.stale) return null
  return sanitizeElementInfo(value)
}

module.exports = {
  beginElementSelection,
  cancelElementSelection,
  resetElementInspector,
  installController,
  getSelectedElement,
  setSelectedElementStyles,
  resetSelectedElementStyles,
  sanitizeElementInfo,
  validateStyleChanges
}
