# @takos/takosumi-kubernetes-providers

Kubernetes-backed `KernelPlugin` factory for the canonical Takosumi `worker`
component kind, targeting vanilla / k3s Deployment + Service. Operators import
this package explicitly when they want Kubernetes coverage — Takosumi core
(`@takos/takosumi-kernel`) ships zero cloud SDK code, so the operator chooses
which provider packages to attach to `createPaaSApp({ plugins: [...] })`.

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel";
import { kubernetesWorkerProvider } from "@takos/takosumi-kubernetes-providers";

const { app } = await createPaaSApp({
  plugins: [
    kubernetesWorkerProvider({
      namespace: "takos",
      clusterDomain: "cluster.local",
    }),
  ],
});
```

## Exports

| Factory                    | Kind URI                               |
| -------------------------- | -------------------------------------- |
| `kubernetesWorkerProvider` | `https://takosumi.com/kinds/v1/worker` |

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — shape
  provider host the factory delegates to.
