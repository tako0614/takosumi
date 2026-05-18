/**
 * `@takos/takosumi-kubernetes-providers` — Kubernetes-backed `KernelPlugin`
 * factories for the `worker` component kind (k3s / vanilla deployment).
 *
 * Phase D extracted this factory out of `@takos/takosumi-plugins/bundled`
 * so Takosumi core no longer carries cloud-coupled imports. Operators that
 * want Kubernetes worker coverage explicitly import this package and pass
 * the factory result into `createPaaSApp({ plugins: [...] })`.
 *
 * Exports:
 *   - `kubernetesWorkerProvider` → `worker@v1` (Kubernetes Deployment)
 */

export {
  kubernetesWorkerProvider,
  type KubernetesWorkerProviderOptions,
} from "./src/worker-kubernetes.ts";
