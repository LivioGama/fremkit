import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))
// The server the dev UI talks to: 4242, or the port `FREMKIT_PORT` moved a second checkout to.
const server = `127.0.0.1:${Number(process.env.FREMKIT_PORT) || 4242}`

export default defineConfig({
  plugins: [vue()],
  build: { rollupOptions: { input: { index: r('index.html'), admin: r('admin.html') } } },
  server: {
    port: 5173,
    proxy: {
      '/api': `http://${server}`,
      // The one-time link that sets the access cookie, for this origin (see docs/contributing.md).
      '/auth': `http://${server}`,
      '/widgets': `http://${server}`,
      '/fremkit.js': `http://${server}`,
      '/ws': { target: `ws://${server}`, ws: true },
    },
  },
})
