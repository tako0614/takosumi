# @takos/takosumi-gcp-providers

GCP-backed `KernelPlugin` factories for the canonical Takosumi component kinds
(`worker` / `object-store` / `postgres`). Operators import this package
explicitly when they want GCP coverage — Takosumi core
(`@takos/takosumi-kernel`) ships zero cloud SDK code, so the operator chooses
which provider packages to attach to `createPaaSApp({ plugins: [...] })`.

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel";
import {
  gcpCloudRunWorkerProvider,
  gcpCloudSqlPostgresProvider,
  gcpGcsObjectStoreProvider,
} from "@takos/takosumi-gcp-providers";

const { app } = await createPaaSApp({
  plugins: [
    gcpCloudRunWorkerProvider({ project: env.GCP_PROJECT, region: env.GCP_REGION }),
    gcpGcsObjectStoreProvider({ project: env.GCP_PROJECT }),
    gcpCloudSqlPostgresProvider({ project: env.GCP_PROJECT, region: env.GCP_REGION }),
  ],
});
```

## Exports

| Factory                          | Kind URI                                       |
| -------------------------------- | ---------------------------------------------- |
| `gcpCloudRunWorkerProvider`      | `https://takosumi.com/kinds/v1/worker`         |
| `gcpGcsObjectStoreProvider`      | `https://takosumi.com/kinds/v1/object-store`   |
| `gcpCloudSqlPostgresProvider`    | `https://takosumi.com/kinds/v1/postgres`       |

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — shape
  provider host the factories delegate to.
