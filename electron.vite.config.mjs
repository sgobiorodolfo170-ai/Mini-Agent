import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'
import tailwindcss from 'tailwindcss'
import autoprefixer from 'autoprefixer'
import commonjs from '@rollup/plugin-commonjs'

const r = (p) => resolve(__dirname, p)

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
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
