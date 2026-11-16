import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const apiTarget = process.env.MARKETHUB_API_URL ?? "http://localhost:3001";
const webHost = process.env.MARKETHUB_WEB_HOST ?? "127.0.0.1";
const webPort = Number(process.env.MARKETHUB_WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: webHost,
    port: Number.isFinite(webPort) ? webPort : 5173,
    strictPort: false,
    proxy: {
      "/health": { target: apiTarget, changeOrigin: true },
      "/ready": { target: apiTarget, changeOrigin: true },
      "/api": { target: apiTarget, changeOrigin: true }
    }
  },
  preview: {
    host: webHost,
    port: 4173
  }
});
