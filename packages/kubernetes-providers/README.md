# @takos/takosumi-kubernetes-providers

Kubernetes-backed `KernelPlugin` factory for the Takos reference `web-service`
component kind, targeting vanilla / k3s Deployment + Service. Operators import
this package explicitly when they want Kubernetes coverage — Takosumi core
(`@takos/takosumi-kernel`) ships zero cloud SDK code, so the operator chooses
which provider packages to attach to
`createPaaSApp({ kindAliases, plugins: [...] })`.

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import { kubernetesWebServiceProvider } from "@takos/takosumi-kubernetes-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    kubernetesWebServiceProvider({
      namespace: "takos",
      clusterDomain: "cluster.local",
    }),
  ],
});
```

## Exports

| Factory                        | Kind URI                                    |
| ------------------------------ | ------------------------------------------- |
| `kubernetesWebServiceProvider` | `https://takosumi.com/kinds/v1/web-service` |

`kubernetesWorkerProvider` remains as a deprecated compatibility alias for
`kubernetesWebServiceProvider`.

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — shape
  provider host the factory delegates to.
