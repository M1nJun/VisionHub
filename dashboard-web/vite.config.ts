import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base must match Spring's server.servlet.context-path (/dashboard) so built
// asset URLs (JS/CSS) resolve correctly once served from there. Build output
// goes straight into DashboardServer's static resources folder so `npm run
// build` + `mvn package` is the whole release process, no manual copy step.
export default defineConfig({
  plugins: [react()],
  base: '/dashboard/',
  server: {
    proxy: {
      '/dashboard/api': {
        target: 'http://127.0.0.1:8080',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../DashboardServer/src/main/resources/static',
    emptyOutDir: true,
  },
})
