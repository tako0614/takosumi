import { defineConfig } from "@solidjs/start/config";

export default defineConfig({
  // True SPA: no SSR, no prerender of specific routes. The static preset
  // emits a shell index.html that bootstraps the client, and the SPA
  // router resolves every path client-side. Caddy / Pages fall back to
  // index.html for unknown paths so deep links work.
  ssr: false,
  server: {
    preset: "static",
  },
});
