const crypto = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const forge = require('node-forge')
const { encryptSecret, decryptSecret } = require('../../store/keys')

const DIRECTORY = 'remote-certificates'
const FILES = {
  caCert: 'ca.pem',
  caKey: 'ca.key.enc',
  cert: 'server.pem',
  key: 'server.key.enc'
}
const ALL_FILES = Object.values(FILES)
const CA_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000
const SERVER_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000
const inFlight = new Map()

function materialDir(dataDir) {
  if (typeof dataDir !== 'string' || !dataDir.trim()) {
    throw new TypeError('dataDir must be a non-empty string')
  }
  return path.join(dataDir, DIRECTORY)
}

function timestamp(now) {
  const value = typeof now === 'function' ? now() : now
  const ms = value == null ? Date.now() : new Date(value).getTime()
  if (!Number.isFinite(ms)) throw new TypeError('now must be a valid date')
  return ms
}

function requireIPv4(ip) {
  if (typeof ip !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip)) {
    throw new TypeError('ip must be a valid IPv4 address')
  }
  const parts = ip.split('.')
  if (parts.some((part) => Number(part) > 255)) {
    throw new TypeError('ip must be a valid IPv4 address')
  }
  return ip
}

function certificateError(message, cause) {
  const error = new Error(`Remote certificate error: ${message}`, cause ? { cause } : undefined)
  error.code = 'REMOTE_CERTIFICATE_ERROR'
  return error
}

function randomSerial() {
  let serial
  do {
    serial = crypto.randomBytes(16).toString('hex')
  } while (serial[0] === '0')
  return serial
}

function certificateFingerprint(pem) {
  const der = forge.asn1
    .toDer(forge.pki.certificateToAsn1(forge.pki.certificateFromPem(pem)))
    .getBytes()
  const digest = crypto.createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex')
  return digest.match(/.{2}/g).join(':').toUpperCase()
}

function assertKey(privateKey, certificate, label) {
  if (privateKey.n.bitLength() < 2048) {
    throw certificateError(`${label} RSA key is smaller than 2048 bits`)
  }
  const publicKey = forge.pki.setRsaPublicKey(privateKey.n, privateKey.e)
  const expected = forge.pki.publicKeyToPem(publicKey)
  if (forge.pki.publicKeyToPem(certificate.publicKey) !== expected) {
    throw certificateError(`${label} private key does not match its certificate`)
  }
}

function validAt(certificate, nowMs) {
  return (
    certificate.validity.notBefore.getTime() <= nowMs &&
    certificate.validity.notAfter.getTime() > nowMs
  )
}

function commonName(value) {
  return [{ name: 'commonName', value }]
}

function createCa(nowMs) {
  const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 })
  const certificate = forge.pki.createCertificate()
  certificate.publicKey = keys.publicKey
  certificate.serialNumber = randomSerial()
  certificate.validity.notBefore = new Date(nowMs - CLOCK_SKEW_MS)
  certificate.validity.notAfter = new Date(nowMs + CA_LIFETIME_MS)
  certificate.setSubject(commonName('Mini Agent Local CA'))
  certificate.setIssuer(certificate.subject.attributes)
  certificate.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' }
  ])
  certificate.sign(keys.privateKey, forge.md.sha256.create())
  return { privateKey: keys.privateKey, certificate }
}

function createServer(caKey, caCert, privateKey, ip, nowMs) {
  const certificate = forge.pki.createCertificate()
  certificate.publicKey =
    privateKey.publicKey || forge.pki.setRsaPublicKey(privateKey.n, privateKey.e)
  certificate.serialNumber = randomSerial()
  certificate.validity.notBefore = new Date(nowMs - CLOCK_SKEW_MS)
  certificate.validity.notAfter = new Date(nowMs + SERVER_LIFETIME_MS)
  certificate.setSubject(commonName('Mini Agent Remote'))
  certificate.setIssuer(caCert.subject.attributes)
  certificate.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 7, ip }] }
  ])
  certificate.sign(caKey, forge.md.sha256.create())
  return certificate
}

function serverAddresses(certificate) {
  const extension = certificate.getExtension('subjectAltName')
  return extension && Array.isArray(extension.altNames)
    ? extension.altNames.filter((entry) => entry.type === 7).map((entry) => entry.ip)
    : []
}

async function writeSecure(file, value) {
  await fs.writeFile(file, value, { encoding: 'utf8', mode: 0o600 })
  await fs.chmod(file, 0o600)
}

async function encryptPrivateKey(privateKey, encrypt, label) {
  const pem = forge.pki.privateKeyToPem(privateKey)
  let stored
  try {
    stored = await encrypt(pem)
  } catch (error) {
    throw certificateError(`${label} private key encryption failed`, error)
  }
  if (typeof stored !== 'string' || !stored) {
    throw certificateError(`${label} private key encryption returned no protected data`)
  }
  if (stored === pem || /-----BEGIN (?:RSA )?PRIVATE KEY-----/.test(stored)) {
    throw certificateError(`${label} private key encryption returned plaintext`)
  }
  return stored
}

async function decryptPrivateKey(file, decrypt, label) {
  let stored
  try {
    stored = await fs.readFile(file, 'utf8')
  } catch (error) {
    throw certificateError(`${label} private key is unreadable`, error)
  }
  let pem
  try {
    pem = await decrypt(stored)
  } catch (error) {
    throw certificateError(`${label} private key decryption failed`, error)
  }
  if (typeof pem !== 'string' || !pem) {
    throw certificateError(`${label} private key decryption failed`)
  }
  try {
    return forge.pki.privateKeyFromPem(pem)
  } catch (error) {
    throw certificateError(`${label} private key is invalid`, error)
  }
}

async function readCertificate(file, label) {
  let pem
  try {
    pem = await fs.readFile(file, 'utf8')
  } catch (error) {
    throw certificateError(`${label} certificate is unreadable`, error)
  }
  try {
    return forge.pki.certificateFromPem(pem)
  } catch (error) {
    throw certificateError(`${label} certificate is invalid`, error)
  }
}

async function missingFiles(dir) {
  const missing = []
  for (const name of ALL_FILES) {
    try {
      await fs.access(path.join(dir, name))
    } catch {
      missing.push(name)
    }
  }
  return missing
}

async function ensureUnlocked({ dataDir, ip, encrypt, decrypt, now }) {
  const dir = materialDir(dataDir)
  requireIPv4(ip)
  const nowMs = timestamp(now)
  const files = Object.fromEntries(
    Object.entries(FILES).map(([key, name]) => [key, path.join(dir, name)])
  )
  const missing = await missingFiles(dir)
  if (missing.length !== 0 && missing.length !== ALL_FILES.length) {
    throw certificateError(`security material is incomplete (missing: ${missing.join(', ')})`)
  }

  let caKey
  let caCert
  let caPem
  let privateKey
  let keyPem
  let certificate
  let certPem

  if (missing.length === 0) {
    caCert = await readCertificate(files.caCert, 'CA')
    caKey = await decryptPrivateKey(files.caKey, decrypt, 'CA')
    assertKey(caKey, caCert, 'CA')
    if (!caCert.verify(caCert)) throw certificateError('CA certificate signature is invalid')
    const constraints = caCert.getExtension('basicConstraints')
    if (!constraints || constraints.cA !== true)
      throw certificateError('CA basicConstraints must have cA=true')
    privateKey = await decryptPrivateKey(files.key, decrypt, 'server')
    certificate = await readCertificate(files.cert, 'server')
    assertKey(privateKey, certificate, 'server')
    if (!validAt(caCert, nowMs)) {
      const replacement = createCa(nowMs)
      caKey = replacement.privateKey
      caCert = replacement.certificate
      caPem = forge.pki.certificateToPem(caCert)
      keyPem = await encryptPrivateKey(caKey, encrypt, 'CA')
      certificate = null
    }
  } else {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const replacement = createCa(nowMs)
    caKey = replacement.privateKey
    caCert = replacement.certificate
    caPem = forge.pki.certificateToPem(caCert)
    keyPem = await encryptPrivateKey(caKey, encrypt, 'CA')
  }

  if (certificate && validAt(certificate, nowMs)) {
    if (!caCert.verify(certificate))
      throw certificateError('server certificate is not signed by the local CA')
    if (!serverAddresses(certificate).includes(ip)) certificate = null
  } else {
    certificate = null
  }

  let serverChanged = false
  if (!certificate) {
    if (!privateKey) {
      const keys = forge.pki.rsa.generateKeyPair({ bits: 2048 })
      privateKey = keys.privateKey
    }
    certificate = createServer(caKey, caCert, privateKey, ip, nowMs)
    certPem = forge.pki.certificateToPem(certificate)
    serverChanged = true
  }
  if (!caPem) caPem = forge.pki.certificateToPem(caCert)
  if (!certPem) certPem = forge.pki.certificateToPem(certificate)

  if (keyPem) {
    await writeSecure(files.caKey, keyPem)
    await fs.writeFile(files.caCert, caPem, 'utf8')
  }
  if (serverChanged) {
    const encrypted = await encryptPrivateKey(privateKey, encrypt, 'server')
    await writeSecure(files.key, encrypted)
    await fs.writeFile(files.cert, certPem, 'utf8')
  }

  return {
    key: forge.pki.privateKeyToPem(privateKey),
    cert: certPem,
    caCert: caPem,
    fingerprint: certificateFingerprint(caPem),
    expiresAt: certificate.validity.notAfter.toISOString()
  }
}

async function ensureCertificate({
  dataDir,
  ip,
  encrypt = encryptSecret,
  decrypt = decryptSecret,
  now
} = {}) {
  const dir = materialDir(dataDir)
  const previous = inFlight.get(dir) || Promise.resolve()
  const operation = previous.then(() => ensureUnlocked({ dataDir, ip, encrypt, decrypt, now }))
  inFlight.set(dir, operation)
  try {
    return await operation
  } finally {
    if (inFlight.get(dir) === operation) inFlight.delete(dir)
  }
}

async function exportCa({ dataDir } = {}) {
  const file = path.join(materialDir(dataDir), FILES.caCert)
  const pem = await fs.readFile(file, 'utf8')
  try {
    forge.pki.certificateFromPem(pem)
    return { caCert: pem, fingerprint: certificateFingerprint(pem) }
  } catch (error) {
    throw certificateError('CA certificate is invalid', error)
  }
}

async function reset({ dataDir } = {}) {
  const dir = materialDir(dataDir)
  await Promise.all(ALL_FILES.map((name) => fs.rm(path.join(dir, name), { force: true })))
}

module.exports = { ensureCertificate, exportCa, reset }
