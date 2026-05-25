# @takos/takosumi-kubernetes-providers

Kubernetes-backed reference `KernelPlugin` adapter factory for the takosumi.com
official catalog `web-service` descriptor, targeting vanilla / k3s Deployment +
Service. Operators import this package explicitly when they want Kubernetes
coverage — Takosumi core (`@takos/takosumi-kernel`) ships zero cloud SDK code,
so the operator chooses which provider packages to attach to the reference
adapter array (`createPaaSApp({ kindAliases, plugins: [...] })`).

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
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

Kubernetes credentials and kubeconfig are configured on the runtime-agent
connector environment or operator host. Provider factory arguments stay limited
to non-secret selector settings such as namespace or cluster domain.

## Exports

| Factory                        | Kind URI                                    |
| ------------------------------ | ------------------------------------------- |
| `kubernetesWebServiceProvider` | `https://takosumi.com/kinds/v1/web-service` |

`kubernetesWorkerProvider` is an alternate export for
`kubernetesWebServiceProvider`.

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — official
  catalog descriptor helpers and reference adapter helpers.
