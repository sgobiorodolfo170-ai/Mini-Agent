const { app, safeStorage } = require('electron')

app.whenReady().then(() => {
  const available = safeStorage.isEncryptionAvailable()
  let roundtrip = null
  if (available) {
    try {
      roundtrip = safeStorage.decryptString(safeStorage.encryptString('secret123')) === 'secret123'
    } catch {
      roundtrip = false
    }
  }
  console.log(JSON.stringify({ available, roundtrip, userData: app.getPath('userData') }))
  app.quit()
})
