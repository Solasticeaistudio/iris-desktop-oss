import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  // These three values are non-secret UI configuration. IRIS_API_KEY is
  // intentionally not included and is read only by the native runtime.
  envPrefix: ['VITE_', 'TAURI_', 'IRIS_MODEL_PROVIDER', 'IRIS_BASE_URL', 'IRIS_MODEL'],
  build: {
    target: 'esnext',
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
})
