const { BrowserWindow, screen } = require('electron')
const path = require('path')
const fs = require('fs')

const windows = new Map()

function isDev() {
  return !!process.env.ELECTRON_RENDERER_URL
}

function rendererUrl(entry) {
  if (isDev()) return `${process.env.ELECTRON_RENDERER_URL}/entries/${entry}/index.html`
  return 'file://' + path.join(__dirname, '../renderer/entries', entry, 'index.html')
}

function preloadPath(name) {
  return path.join(__dirname, '../preload', `${name}.js`)
}

function webPrefs(preload, bridge) {
  return {
    preload: preloadPath(preload),
    additionalArguments: [`--bridge=${bridge}`],
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false
  }
}

function appIcon() {
  const p = path.join(__dirname, '../../assets/icon-256.png')
  return fs.existsSync(p) ? p : undefined
}

function createMainWindow() {
  if (windows.has('main')) return windows.get('main')
  const win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#101014',
    icon: appIcon(),
    title: 'miniagent',
    webPreferences: webPrefs('index', 'main')
  })
  win.setMenuBarVisibility(false)
  win.loadURL(rendererUrl('main-window'))
  win.once('ready-to-show', () => win.show())
  windows.set('main', win)
  win.on('closed', () => windows.delete('main'))
  return win
}

function createQuickWindow() {
  if (windows.has('quick')) return windows.get('quick')
  const wa = screen.getPrimaryDisplay().workArea
  const width = 760
  const height = 520
  const win = new BrowserWindow({
    width,
    height,
    x: Math.round(wa.x + (wa.width - width) / 2),
    y: wa.y + Math.max(40, Math.round(wa.height * 0.1)),
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    backgroundColor: '#17171c',
    roundedCorners: true,
    webPreferences: webPrefs('index', 'quick')
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadURL(rendererUrl('quick-panel'))
  windows.set('quick', win)
  win.on('closed', () => windows.delete('quick'))
  return win
}

function createBallWindow() {
  if (windows.has('ball')) return windows.get('ball')
  const wa = screen.getPrimaryDisplay().workArea
  const size = 56
  const win = new BrowserWindow({
    width: size,
    height: size,
    x: wa.x + wa.width - size - 20,
    y: wa.y + wa.height - size - 24,
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    fullscreenable: false,
    webPreferences: webPrefs('index', 'ball')
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadURL(rendererUrl('floating-ball'))
  win.once('ready-to-show', () => win.show())
  windows.set('ball', win)
  win.on('closed', () => windows.delete('ball'))
  return win
}

function createCaptureWindow(display) {
  closeWindow('capture')
  const b = display.bounds
  const win = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    resizable: false,
    movable: false,
    minimizable: false,
    webPreferences: webPrefs('index', 'capture')
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.loadURL(rendererUrl('screen-capture'))
  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })
  windows.set('capture', win)
  win.on('closed', () => windows.delete('capture'))
  return win
}

function show(name) {
  const win = windows.get(name)
  if (!win) return null
  if (name === 'main') {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } else {
    win.show()
    win.focus()
  }
  return win
}

function hide(name) {
  const win = windows.get(name)
  if (win) win.hide()
  return !!win
}

function toggle(name) {
  const win = windows.get(name)
  if (win && win.isVisible()) {
    win.hide()
    return false
  }
  show(name)
  return true
}

function isVisible(name) {
  const win = windows.get(name)
  return !!(win && win.isVisible())
}

function closeWindow(name) {
  const win = windows.get(name)
  if (win) win.close()
}

function broadcast(channel, payload) {
  for (const win of windows.values()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

function sendTo(name, channel, payload) {
  const win = windows.get(name)
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

module.exports = {
  createMainWindow,
  createQuickWindow,
  createBallWindow,
  createCaptureWindow,
  show,
  hide,
  toggle,
  isVisible,
  closeWindow,
  broadcast,
  sendTo,
  get: (name) => windows.get(name)
}
