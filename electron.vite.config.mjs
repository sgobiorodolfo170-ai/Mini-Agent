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
    plugins: [vue()],
    css: {
      postcss: { plugins: [tailwindcss, autoprefixer] }
    },
    build: {
      rollupOptions: {
        input: {
          main: r('src/entries/main-window/index.html'),
          quick: r('src/entries/quick-panel/index.html'),
          ball: r('src/entries/floating-ball/index.html'),
          capture: r('src/entries/screen-capture/index.html')
        }
      }
    }
  }
})
