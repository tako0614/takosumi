import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  server: {
    preset: "static",
    prerender: {
      crawlLinks: false,
      routes: ["/"],
    },
  },
  vite: {
    esbuild: { target: "esnext" },
  },
});
