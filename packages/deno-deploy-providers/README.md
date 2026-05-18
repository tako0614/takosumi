# @takos/takosumi-deno-deploy-providers

Deno Deploy-backed `KernelPlugin` factory for the canonical Takosumi `worker`
component kind. Operators import this package explicitly when they want Deno
Deploy coverage — Takosumi core (`@takos/takosumi-kernel`) ships zero cloud
SDK code, so the operator chooses which provider packages to attach to
`createPaaSApp({ plugins: [...] })`.

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel";
import { denoDeployWorkerProvider } from "@takos/takosumi-deno-deploy-providers";

const { app } = await createPaaSApp({
  plugins: [
    denoDeployWorkerProvider({ organizationId: env.DENO_DEPLOY_ORG_ID }),
  ],
});
```

## Exports

| Factory                      | Kind URI                               |
| ---------------------------- | -------------------------------------- |
| `denoDeployWorkerProvider`   | `https://takosumi.com/kinds/v1/worker` |

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — shape
  provider host the factory delegates to.
