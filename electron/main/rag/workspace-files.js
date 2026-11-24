const fs = require('fs')
const path = require('path')
const { TEXT_EXTENSIONS, TEXT_FILENAMES } = require('./extract')

const MAX_WORKSPACE_FILES = 2000
const MAX_WORKSPACE_FILE_BYTES = 1024 * 1024
const IGNORED_DIRS = new Set([
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'coverage',
  '.git',
  '.hg',
  '.svn',
  '.venv',
  'venv',
  '__pycache__',
  'target',
  '.next',
  '.nuxt',
  '.cache',
  '.idea',
  '.vscode'
])
const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.docx', '.pdf'])
const SPECIAL_FILES = TEXT_FILENAMES

function isWorkspaceFile(name) {
  const ext = path.extname(name).toLowerCase()
  return SPECIAL_FILES.has(name) || TEXT_EXTENSIONS.has(ext) || DOCUMENT_EXTENSIONS.has(ext)
}

async function collectWorkspaceFiles(rootPath) {
  const root = path.resolve(rootPath)
  const stat = await fs.promises.stat(root)
  if (!stat.isDirectory()) throw new Error('工作区路径不是文件夹')
  const files = []

  async function walk(dir) {
    if (files.length >= MAX_WORKSPACE_FILES) return
    const entries = await fs.promises.readdir(dir, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (files.length >= MAX_WORKSPACE_FILES) return
      if (entry.isSymbolicLink()) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue
        await walk(full)
        continue
      }
      if (!entry.isFile() || !isWorkspaceFile(entry.name)) continue
      if (/^(package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(entry.name)) continue
      if (/^(\.env(?:\..*)?|credentials\.json|service-account.*\.json)$/i.test(entry.name)) {
        continue
      }
      const info = await fs.promises.stat(full)
      if (!info.size || info.size > MAX_WORKSPACE_FILE_BYTES) continue
      const buf = await fs.promises.readFile(full)
      if (!DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase()) && buf.includes(0)) {
        continue
      }
      files.push(full)
    }
  }

  await walk(root)
  return files
}

module.exports = {
  collectWorkspaceFiles,
  isWorkspaceFile,
  MAX_WORKSPACE_FILES,
  MAX_WORKSPACE_FILE_BYTES
}
