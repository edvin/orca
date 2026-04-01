import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";

export default defineConfig({
  plugins: [
    solidPlugin(),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api/v1": {
        target: "http://127.0.0.1:9477",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "esnext",
  },
});
