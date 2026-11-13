import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Some NEAR libraries reference Node's `global`.
  define: { global: 'globalThis' },
})
