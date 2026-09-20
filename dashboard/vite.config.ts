import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@thoth/remotion-composition": path.resolve(
        __dirname,
        "../packages/remotion-composition/src",
      ),
    },
    // The shared composition lives outside this app, so Remotion and React must
    // still resolve to this app's single copy of each.
    dedupe: ["react", "react-dom", "remotion"],
  },
  server: {
    proxy: {
      "/api/v1": "http://127.0.0.1:8000",
      "/api": "http://127.0.0.1:9090",
      "/health": "http://127.0.0.1:9090",
    },
  },
});
