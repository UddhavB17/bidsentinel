import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:4321",
      "/health": "http://127.0.0.1:4321",
    },
  },
});
