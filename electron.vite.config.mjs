import { resolve } from 'path'
import { execFileSync } from 'child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import commonjs from '@rollup/plugin-commonjs'

const r = (p) => resolve(__dirname, p)

// 构建时把提交号写进主进程，供「检查更新」和本地提交比较（无 git 环境时留空，
// 更新检查会退回版本号比较，不会误判）。
function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim()
  } catch {
    return process.env.MINIAGENT_COMMIT || ''
  }
}

const buildInfo = {
  __BUILD_COMMIT__: JSON.stringify(gitCommit()),
  __BUILD_TIME__: JSON.stringify(new Date().toISOString())
}

// 开发预览用：TRAE 内置浏览器的「选择元素」由外部脚本 previewer-tools.umd.js
// （lf3-static.bytednsdoc.com）注入实现，页面的严格 CSP 会把它拦在 script-src，
// 且脚本内部通过 fetch 上报选中元素需要 connect-src。仅在 dev server 下放开
// 该来源与内联/求值能力，并只作用于主窗口入口；生产构建保持原 CSP 不变。
const PREVIEWER_ORIGIN = 'https://lf3-static.bytednsdoc.com'
function devRelaxedCsp() {
  return {
    name: 'dev-relaxed-csp',
    apply: 'serve',
    transformIndexHtml(html, ctx) {
      if (!/main-window/.test(ctx.filename || ctx.path || '')) return html
      return html
        .replace(
          "script-src 'self'",
          `script-src 'self' 'unsafe-inline' 'unsafe-eval' ${PREVIEWER_ORIGIN}`
        )
        .replace("default-src 'self'", `default-src 'self'; connect-src 'self' https: ws: wss:`)
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: buildInfo,
    build: {
      rollupOptions: {
        input: { index: r('electron/main/index.js') },
        plugins: [commonjs()]
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: r('electron/preload/index.js') },
        plugins: [commonjs()],
        output: {
          inlineDynamicImports: true
        }
      }
    }
  },
  renderer: {
    root: r('src'),
    plugins: [vue(), devRelaxedCsp()],
    css: {
      postcss: { plugins: [tailwindcss, autoprefixer] }
    },
    build: {
      rollupOptions: {
        input: {
          main: r('src/entries/main-window/index.html'),
          quick: r('src/entries/quick-panel/index.html'),
          ball: r('src/entries/floating-ball/index.html'),
          capture: r('src/entries/screen-capture/index.html'),
          'remote-mobile': r('src/entries/remote-mobile/index.html')
        }
      }
    }
  }
})
