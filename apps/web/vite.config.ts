import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { monacoFontPlugin } from "./vite-monaco-font";

export default defineConfig({
  plugins: [monacoFontPlugin(), react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8765",
      "/health": "http://127.0.0.1:8765",
    },
  },
});
