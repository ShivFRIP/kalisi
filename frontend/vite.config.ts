import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// API_TARGET lets several dev servers point at different backends (e.g. one per test database).
export default defineConfig({
  plugins: [react()],
  cacheDir: process.env.VITE_CACHE_DIR || "node_modules/.vite",   // parallel dev servers need separate caches
  server: {
    port: Number(process.env.PORT || 5173),
    proxy: Object.fromEntries(["/api", "/docs", "/openapi.json"].map((p) => [p, process.env.API_TARGET || "http://localhost:8000"])),
  },
});
