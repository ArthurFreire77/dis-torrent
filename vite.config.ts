import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { fileURLToPath } from 'url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    host: '127.0.0.1',
    strictPort: true,
    fs: { strict: true },
    // `dist-release` guarda os instaladores gerados: o Vite tentava vigiar os
    // .exe/.apk e morria com EBUSY (arquivo travado pelo Explorer/antivírus).
    // O `target/` do Rust é o mesmo problema quando o cargo test está rodando.
    watch: {
      ignored: [
        '**/src-tauri/**',
        '**/dist/**',
        '**/dist-release/**',
        '**/test-results/**',
        '**/target/**',
      ],
    },
  },
  preview: { port: 5173, host: '127.0.0.1', strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    cssCodeSplit: true,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom', 'react-router-dom'],
          tauri: ['@tauri-apps/api'],
        },
      },
    },
  },
  resolve: { alias: { '@': path.resolve(__dirname, './src') } },
})
