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
    // `src-tauri/target` é saída de build: o Inno/cargo criam arquivos
    // bloqueados ali e o watcher do Vite morria com EBUSY ("resource busy or
    // locked"), derrubando o dev server no meio do trabalho.
    watch: { ignored: ['**/src-tauri/**', '**/dist/**', '**/test-results/**'] },
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
