import path from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") } },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          const moduleId = id.split("\\").join("/")
          if (/\/node_modules\/(motion|framer-motion|motion-dom|motion-utils)\//.test(moduleId)) return "motion"
          if (/\/node_modules\/(gsap|ogl)\//.test(moduleId)) return "visual-effects"
          if (/\/node_modules\/(react|react-dom|scheduler|react-router|react-router-dom|@tanstack)\//.test(moduleId)) return "framework"
        },
      },
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": process.env.MOONCELL_DEV_BACKEND_URL ?? "http://127.0.0.1:8000",
    },
  },
})
