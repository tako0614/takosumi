/**
 * `@takos/takosumi-deno-deploy-providers` — Deno Deploy-backed
 * `KernelPlugin` factories for the operator-opt-in `worker` reference kind URI.
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
