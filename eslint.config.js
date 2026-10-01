import js from '@eslint/js'
import typescript from 'typescript-eslint'

export default [
  // `host/target` e `forge-core/target` são artefatos de build (CMake/speexdsp
  // geram .ts/.make que o parser de JS não entende) — nunca entra no lint.
  { ignores: ['dist/', 'node_modules/', 'src-tauri/target/', 'src-tauri/gen/', 'forge-core/target/', 'host/target/', 'aec-probe/target/', '*/target/', 'cmdline-tools/', 'test-results/', '.playwright-mcp/'] },
  js.configs.recommended,
  ...typescript.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
]
