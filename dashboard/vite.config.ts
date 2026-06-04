import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { resolve } from "node:path";

// Standalone build of the Takosumi dashboard SPA (account plane + installations
// screens). When consumed by the takos product web build, these sources are
// referenced through the `@takosumi/dashboard` vite alias instead; this config
// only governs the standalone `bun run build` / `bun run dev` that ships the
// dashboard inside the Takosumi platform worker (deploy/platform/).
export default defineConfig({
  plugins: [solid()],
  root: resolve(__dirname),
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
    sourcemap: false,
    minify: "esbuild",
  },
  server: {
    host: true,
  },
});
