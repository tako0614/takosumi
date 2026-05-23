# @takos/takosumi-deno-deploy-providers

Deno Deploy-backed `KernelPlugin` factory for the Takos reference `worker`
component kind. Operators import this package explicitly when they want Deno
Deploy coverage — Takosumi core (`@takos/takosumi-kernel`) ships zero cloud SDK
code, so the operator chooses which provider packages to attach to
`createPaaSApp({ kindAliases, plugins: [...] })`.

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import { denoDeployWorkerProvider } from "@takos/takosumi-deno-deploy-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    denoDeployWorkerProvider({ organizationId: env.DENO_DEPLOY_ORG_ID }),
  ],
});
```

## Exports

| Factory                    | Kind URI                               |
| -------------------------- | -------------------------------------- |
| `denoDeployWorkerProvider` | `https://takosumi.com/kinds/v1/worker` |

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — shape
  provider host the factory delegates to.
