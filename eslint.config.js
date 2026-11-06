import js from '@eslint/js'
import typescript from 'typescript-eslint'

export default [
  { ignores: ['dist/', 'node_modules/', 'src-tauri/target/', 'src-tauri/gen/', 'distorrent-core/target/', 'host/target/', 'aec-probe/target/', '*/target/', 'cmdline-tools/', 'test-results/', '.playwright-mcp/', 'scripts/', 'tools/', '.opencode/'] },
  js.configs.recommended,
  ...typescript.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
]
