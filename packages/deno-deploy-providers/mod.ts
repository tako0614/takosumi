/**
 * `@takos/takosumi-deno-deploy-providers` — Deno Deploy-backed
 * `KernelPlugin` factories for the `worker` component kind.
 *
 * Phase D extracted this factory out of `@takos/takosumi-plugins` reference registry
 * so Takosumi core no longer carries cloud-coupled imports. Operators that
 * want Deno Deploy worker coverage explicitly import this package and pass
 * the factory result into `createPaaSApp({ kindAliases, plugins: [...] })`.
 *
 * Exports:
 *   - `denoDeployWorkerProvider` → `worker@v1` (Deno Deploy)
 */

export {
  denoDeployWorkerProvider,
  type DenoDeployWorkerProviderOptions,
} from "./src/worker-deno-deploy.ts";
