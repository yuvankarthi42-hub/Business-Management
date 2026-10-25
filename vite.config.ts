import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  // VITE_BACKEND=catalyst npm run dev → /server/api goes to the local backend (cd backend && npm run dev).
  server: { port: 5173, host: true, proxy: { '/server/api': { target: process.env.API_PROXY ?? 'http://localhost:8787', changeOrigin: true }, '/server/events': { target: process.env.API_PROXY ?? 'http://localhost:8787', changeOrigin: true } } },
})
