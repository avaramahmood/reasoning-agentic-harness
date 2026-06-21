import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Frontend talks to the control server (/api) and llama-server (/v1), both
// proxied to avoid CORS. Tailwind v4 runs via its Vite plugin (no postcss config).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // relative asset paths so the built app loads under file:// inside Electron
  base: "./",
  server: {
    port: 5173,
    proxy: {
      "/v1": { target: "http://127.0.0.1:8080", changeOrigin: true },
      "/api": { target: "http://127.0.0.1:8081", changeOrigin: true },
    },
  },
});
