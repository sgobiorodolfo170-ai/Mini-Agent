import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const forge = require('node-forge')
const { ensureCertificate, exportCa, reset } = require('../../electron/main/remote/certificate-service')

const NOW = new Date('2026-11-22T00:00:00.000Z')
const IP = '192.168.1.23'

async function encrypt(plain) {
  return 'test:' + Buffer.from(plain, 'utf8').toString('base64')
}

async function decrypt(stored) {
  if (!stored.startsWith('test:')) throw new Error('unknown protection format')
  return Buffer.from(stored.slice(5), 'base64').toString('utf8')
}

function options(dataDir, ip = IP, now = NOW) {
  return { dataDir, ip, encrypt, decrypt, now }
}

function files(dataDir) {
  const dir = path.join(dataDir, 'remote-certificates')
  return {
    dir,
    caCert: path.join(dir, 'ca.pem'),
    caKey: path.join(dir, 'ca.key.enc'),
    cert: path.join(dir, 'server.pem'),
    key: path.join(dir, 'server.key.enc')
  }
}

describe('remote certificate service', () => {
  let dataDir

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mini-agent-remote-cert-'))
  })

  afterEach(async () => {
    await fs.rm(dataDir, { recursive: true, force: true })
  })

  it('generates an RSA CA and an IP-only SAN server certificate', async () => {
    const result = await ensureCertificate(options(dataDir))
    const ca = forge.pki.certificateFromPem(result.caCert)
    const server = forge.pki.certificateFromPem(result.cert)
    const key = forge.pki.privateKeyFromPem(result.key)

    expect(ca.publicKey.n.bitLength()).toBeGreaterThanOrEqual(2048)
    expect(key.n.bitLength()).toBeGreaterThanOrEqual(2048)
    expect(ca.getExtension('basicConstraints').cA).toBe(true)
    expect(server.getExtension('basicConstraints').cA).toBe(false)
    expect(server.getExtension('subjectAltName').altNames).toHaveLength(1)
    expect(server.getExtension('subjectAltName').altNames[0]).toMatchObject({ type: 7, ip: IP })
    expect(ca.verify(server)).toBe(true)
    expect(ca.subject.getField('CN').value).not.toContain(IP)
    expect(server.subject.getField('CN').value).toBe('Mini Agent Remote')
    expect(server.validity.notAfter.toISOString()).toBe(result.expiresAt)
    expect(result.expiresAt).toBe('2026-12-22T00:00:00.000Z')
    expect(result.fingerprint).toMatch(/^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    expect(server.serialNumber).toMatch(/^[0-9a-f]{32}$/)
    expect(ca.serialNumber).not.toBe(server.serialNumber)

    const exported = await exportCa({ dataDir })
    expect(exported).toEqual({ caCert: result.caCert, fingerprint: result.fingerprint })
  })

  it('reuses all unexpired material without rewriting encrypted keys', async () => {
    const first = await ensureCertificate(options(dataDir))
    const paths = files(dataDir)
    const before = await Promise.all([paths.caKey, paths.cert, paths.key].map((file) => fs.readFile(file, 'utf8')))
    const second = await ensureCertificate(options(dataDir, IP, new Date(NOW.getTime() + 86400000)))

    expect(second).toEqual(first)
    const after = await Promise.all([paths.caKey, paths.cert, paths.key].map((file) => fs.readFile(file, 'utf8')))
    expect(after).toEqual(before)
  })

  it('re-signs for a new IP while preserving the CA and server private key', async () => {
    const first = await ensureCertificate(options(dataDir))
    const paths = files(dataDir)
    const caKeyBefore = await fs.readFile(paths.caKey, 'utf8')
    const serverKeyBefore = await fs.readFile(paths.key, 'utf8')
    const second = await ensureCertificate(options(dataDir, '10.20.30.40'))

    expect(second.caCert).toBe(first.caCert)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.key).toBe(first.key)
    expect(second.cert).not.toBe(first.cert)
    const san = forge.pki.certificateFromPem(second.cert).getExtension('subjectAltName').altNames
    expect(san).toHaveLength(1)
    expect(san[0]).toMatchObject({ type: 7, ip: '10.20.30.40' })
    expect(await fs.readFile(paths.caKey, 'utf8')).toBe(caKeyBefore)
    expect(await fs.readFile(paths.key, 'utf8')).toBe(serverKeyBefore)
  })

  it('stores only encrypted private keys with restrictive file modes', async () => {
    await ensureCertificate(options(dataDir))
    const paths = files(dataDir)

    for (const file of [paths.caKey, paths.key]) {
      const stored = await fs.readFile(file, 'utf8')
      expect(stored).toMatch(/^test:/)
      expect(stored).not.toContain('PRIVATE KEY')
      expect(await decrypt(stored)).toContain('BEGIN RSA PRIVATE KEY')
      if (process.platform !== 'win32') expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
    }
  })

  it('rejects an encryptor that returns plaintext private keys', async () => {
    await expect(ensureCertificate({ ...options(dataDir), encrypt: async (value) => value }))
      .rejects.toThrow('CA private key encryption returned plaintext')
    expect(await fs.readdir(path.join(dataDir, 'remote-certificates'))).toEqual([])
  })

  it('reports corrupt certificate material instead of regenerating silently', async () => {
    await ensureCertificate(options(dataDir))
    const paths = files(dataDir)
    await fs.writeFile(paths.cert, 'not a certificate', 'utf8')

    await expect(ensureCertificate(options(dataDir))).rejects.toMatchObject({
      code: 'REMOTE_CERTIFICATE_ERROR',
      message: expect.stringMatching(/server certificate is invalid/)
    })
  })

  it('reports private-key decryption failures and never overwrites the stored key', async () => {
    await ensureCertificate(options(dataDir))
    const paths = files(dataDir)
    const before = await fs.readFile(paths.caKey, 'utf8')
    const failingDecrypt = async () => {
      throw new Error('DPAPI unavailable')
    }

    await expect(ensureCertificate({ ...options(dataDir), decrypt: failingDecrypt }))
      .rejects.toThrow('CA private key decryption failed')
    expect(await fs.readFile(paths.caKey, 'utf8')).toBe(before)
  })

  it('reset removes only module-owned files and export fails afterwards', async () => {
    await ensureCertificate(options(dataDir))
    const paths = files(dataDir)
    const unrelated = path.join(paths.dir, 'keep.txt')
    const sibling = path.join(dataDir, 'unrelated-secret.txt')
    await fs.writeFile(unrelated, 'keep', 'utf8')
    await fs.writeFile(sibling, 'keep', 'utf8')

    await reset({ dataDir })
    expect(await fs.readdir(paths.dir)).toEqual(['keep.txt'])
    expect(await fs.readFile(unrelated, 'utf8')).toBe('keep')
    expect(await fs.readFile(sibling, 'utf8')).toBe('keep')
    await expect(exportCa({ dataDir })).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
