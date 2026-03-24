import { defineConfig } from "vite";
import solidPlugin from "vite-plugin-solid";
import monacoEditorPlugin from "vite-plugin-monaco-editor";

export default defineConfig({
  plugins: [
    solidPlugin(),
    (monacoEditorPlugin as any).default({
      languageWorkers: ["editorWorkerService", "json"],
    }),
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
