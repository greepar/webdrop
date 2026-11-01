import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiTarget = env.API_PROXY_TARGET || 'http://127.0.0.1:8080'

  return {
    plugins: [react(), tailwindcss()],
    resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      proxy: {
        // Keep the browser Host (changeOrigin: false) so the backend's same-origin check
        // sees Origin == Host-derived origin on LAN (e.g. 192.168.x.x:5173). changeOrigin:true
        // rewrites Host to 127.0.0.1:8080 and breaks LAN with ORIGIN_FORBIDDEN.
        '/api': { target: apiTarget, changeOrigin: false },
        // Raw public file links keep their backend status and byte response.
        '/d/': { target: apiTarget, changeOrigin: false },
      },
    },
  }
})
