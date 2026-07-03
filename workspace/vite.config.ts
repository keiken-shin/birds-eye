import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// `@bridge` is the Tauri backend bridge (nativeClient.ts) and domain helpers.
const bridge = fileURLToPath(new URL("./src/bridge", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@bridge": bridge },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
