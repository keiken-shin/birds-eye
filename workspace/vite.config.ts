import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// `@bridge` resolves to the existing frontend's source so the new shell reuses the
// backend bridge (nativeClient.ts) and domain helpers verbatim — no copy, no drift.
const bridge = fileURLToPath(new URL("../frontend/src", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@bridge": bridge },
  },
  server: {
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    // Allow importing files from the sibling frontend/src (outside this root).
    fs: { allow: [".."] },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
