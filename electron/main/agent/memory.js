// Long-term memory for the Agent: a single markdown file in userData.
// Sections are `## <name>` blocks; injected into the system prompt at run start.
const fs = require('fs')
const path = require('path')
const fsp = fs.promises

// 把整份记忆文本解析为 [{ name, body }] 小节列表（body 含 `## ` 标题行）。
function parseSections(text) {
  const sections = []
  const re = /^## (.+)$/gm
  const marks = []
  let m
  while ((m = re.exec(text))) marks.push({ name: m[1].trim(), start: m.index })
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].start : text.length
    sections.push({ name: marks[i].name, body: text.slice(marks[i].start, end) })
  }
  return sections
}

// 按 `## name` 小节 upsert；name 匹配不区分大小写与首尾空白。
async function upsertMemoryFile(memoryPath, name, content) {
  const key = String(name || '').trim()
  if (!key) throw new Error('记忆名称不能为空')
  let old = ''
  try {
    old = await fsp.readFile(memoryPath, 'utf8')
  } catch {
    // 首次写入时文件尚不存在
  }
  const sec = `## ${key}\n${String(content == null ? '' : content).trim()}\n`
  const sections = parseSections(old)
  const hit = sections.find((s) => s.name.toLowerCase() === key.toLowerCase())

  let out
  if (hit) {
    hit.body = sec
    out = sections
      .map((s) => s.body)
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
  } else {
    out = (old ? old.replace(/\s*$/, '\n\n') : '') + sec
  }
  await fsp.mkdir(path.dirname(memoryPath), { recursive: true })
  await fsp.writeFile(memoryPath, out, 'utf8')
  return hit ? `已更新记忆「${key}」` : `已保存记忆「${key}」`
}

function readMemoryFile(memoryPath, maxChars = 8000) {
  try {
    return fs.readFileSync(memoryPath, 'utf8').slice(0, maxChars)
  } catch {
    return ''
  }
}

module.exports = { upsertMemoryFile, readMemoryFile, parseSections }
