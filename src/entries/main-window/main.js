import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import '../../common/style.css'

async function bootstrap() {
  // 浏览器预览：没有 Electron preload 时挂载内存版 mock bridge（仅开发环境）
  if (import.meta.env.DEV && !window.api) {
    const { installMockApi } = await import('../../dev/mockApi')
    installMockApi()
  }
  createApp(App).use(createPinia()).mount('#app')
}

bootstrap()
