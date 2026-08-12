import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      // TWO ENTRIES, and that is the point. The kiosk (index.html) and the
      // parent dashboard (dashboard.html) build to separate bundles, so the
      // wall never downloads a line of admin code and no dashboard change can
      // alter what the kitchen loads. There is no router in the kiosk app and
      // this is why one was not needed.
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        dashboard: resolve(import.meta.dirname, 'dashboard.html'),
      },
    },
  },
})
