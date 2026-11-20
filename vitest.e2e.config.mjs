import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['e2e/**/*.spec.js'],
    testTimeout: 90000,
    hookTimeout: 60000,
    fileParallelism: false,
    pool: 'forks'
  }
})
