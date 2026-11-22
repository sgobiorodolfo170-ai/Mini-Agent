/**
 * remote-mobile 入口：手机浏览器通过 HTTPS/WSS 访问桌面本地服务。
 * 不引入 router / Pinia：单页足够，凭证与状态都在 App.vue 内自持。
 * 样式只用本地 remote.css，不依赖任何 CDN 或 Tailwind 指令。
 */
import { createApp } from 'vue'
import App from './App.vue'
import './remote.css'

createApp(App).mount('#app')
