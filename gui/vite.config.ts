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
        // ORCA_DAEMON_URL points the dev server at another daemon (e.g. a test one).
        target: process.env.ORCA_DAEMON_URL ?? "http://127.0.0.1:9477",
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    target: "esnext",
  },
});
