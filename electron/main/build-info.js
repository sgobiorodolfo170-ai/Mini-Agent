// 构建信息：提交号由 electron.vite.config.mjs 在打包时注入（define），
// 单测/直接跑源码时退化为环境变量，两者都没有就留空（更新检查改用版本号比较）。
/* global __BUILD_COMMIT__, __BUILD_TIME__ */

const COMMIT =
  typeof __BUILD_COMMIT__ !== 'undefined' ? __BUILD_COMMIT__ : process.env.MINIAGENT_COMMIT || ''
const BUILT_AT = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : ''

function getBuildCommit() {
  return COMMIT || ''
}

function getBuildInfo() {
  return { commit: COMMIT || '', builtAt: BUILT_AT || '' }
}

module.exports = { getBuildCommit, getBuildInfo }
