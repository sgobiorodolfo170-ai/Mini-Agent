const { Tray, Menu, nativeImage } = require('electron')
const path = require('path')

let tray = null

function createTray({ onShowMain, onQuick, onQuit }) {
  if (tray) return tray
  const iconPath = path.join(__dirname, '../../assets/tray.png')
  const icon = nativeImage.createFromPath(iconPath)
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('miniagent')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: onShowMain },
      { label: '快速输入 (Alt+Space)', click: onQuick },
      { type: 'separator' },
      { label: '退出', click: onQuit }
    ])
  )
  return tray
}

function destroyTray() {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

module.exports = { createTray, destroyTray }
