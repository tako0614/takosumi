/**
 * `@takos/takosumi-cloudflare-providers` — Cloudflare-backed
 * `KernelPlugin` factories for the canonical Takosumi component kinds.
 *
 * Phase D extracted these factories out of `@takos/takosumi-plugins/bundled`
 * so Takosumi core no longer carries cloud-coupled imports. Operators that
 * want Cloudflare provider coverage explicitly import this package and pass
 * the factory result into `createPaaSApp({ plugins: [...] })`.
 *
 * Exports:
 *   - `cloudflareWorkerProvider`         → `worker@v1` (Cloudflare Workers)
 *   - `cloudflareR2ObjectStoreProvider`  → `object-store@v1` (Cloudflare R2)
 *   - `cloudflareCustomDomainProvider`   → `custom-domain@v1` (Cloudflare DNS)
 */

export {
  cloudflareWorkerProvider,
  type CloudflareWorkerProviderOptions,
} from "./src/worker-cloudflare.ts";
export {
  cloudflareR2ObjectStoreProvider,
  type CloudflareR2ProviderOptions,
} from "./src/object-store-cloudflare-r2.ts";
export {
  cloudflareCustomDomainProvider,
  type CloudflareCustomDomainProviderOptions,
} from "./src/custom-domain-cloudflare.ts";
