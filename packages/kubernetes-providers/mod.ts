/**
 * `@takos/takosumi-kubernetes-providers` — Kubernetes-backed `KernelPlugin`
 * factories for the `web-service` component kind (k3s / vanilla deployment).
 *
 * Phase D extracted this factory out of `@takos/takosumi-plugins` reference registry
 * so Takosumi core no longer carries cloud-coupled imports. Operators that
 * want Kubernetes web-service coverage explicitly import this package and pass
 * the factory result into `createPaaSApp({ kindAliases, plugins: [...] })`.
 *
 * Exports:
 *   - `kubernetesWebServiceProvider` → `web-service@v1` (Kubernetes Deployment)
 */

export {
  kubernetesWebServiceProvider,
  type KubernetesWebServiceProviderOptions,
  kubernetesWorkerProvider,
  type KubernetesWorkerProviderOptions,
} from "./src/worker-kubernetes.ts";
