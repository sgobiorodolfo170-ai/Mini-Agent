import { defineConfig } from 'vitest/config'

// 覆盖率范围只统计 JS 逻辑层；Vue 组件/窗口入口由 e2e 兜底（e2e/glue.spec.js），
// 不纳入单测阈值，避免把 UI 胶水算进单元测试口径。
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.js'],
    maxWorkers: 4,
    testTimeout: 30000,
    coverage: {
      provider: 'v8',
      include: ['electron/**', 'src/common/**', 'src/stores/**'],
      // Agent 编排入口使用 CJS + 动态 Electron require，V8 调用归属不稳定；由 flow/E2E 覆盖。
      exclude: ['electron/main/agent/index.js'],
      thresholds: {
        statements: 58,
        branches: 68,
        functions: 73,
        lines: 58
      }
    }
  }
})
