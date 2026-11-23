const js = require('@eslint/js')
const pluginVue = require('eslint-plugin-vue')
const globals = require('globals')
const tsParser = require('@typescript-eslint/parser')
const vueParser = require('vue-eslint-parser')

module.exports = [
  { ignores: ['out/**', 'dist-app/**', 'node_modules/**', 'build/**', 'assets/**'] },
  js.configs.recommended,
  ...pluginVue.configs['flat/essential'],
  {
    files: ['electron/**/*.js', 'tests/**/*.js'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    // jsdom 环境的 store 单测会直接使用 window/document
    files: ['tests/unit/stores/**/*.js'],
    languageOptions: { globals: { ...globals.browser } }
  },
  {
    files: ['src/**/*.{vue,js}', 'src/**/*.js'],
    languageOptions: { globals: { ...globals.browser } }
  },
  {
    files: ['src/**/*.vue'],
    languageOptions: {
      globals: { ...globals.browser },
      parser: vueParser,
      parserOptions: {
        parser: tsParser,
        extraFileExtensions: ['.vue'],
        ecmaVersion: 'latest',
        sourceType: 'module'
      }
    }
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
      parser: tsParser,
      parserOptions: { ecmaVersion: 'latest', sourceType: 'module' }
    }
  },
  {
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
      'vue/multi-word-component-names': 'off'
    }
  }
]
