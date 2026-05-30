import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // ggwave ships as a WASM module — exclude from pre-bundling so the
    // dynamic import() in AppNew.jsx resolves the .wasm file correctly.
    exclude: ['ggwave'],
  },
  server: {
    headers: {
      // Required for SharedArrayBuffer / WASM threading (ggwave may need these)
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
  },
})
