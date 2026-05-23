# @takos/takosumi-gcp-providers

GCP-backed `KernelPlugin` factories for the Takos reference component kinds
(`web-service` / `object-store` / `postgres`). Operators import this package
explicitly when they want GCP coverage — Takosumi core
(`@takos/takosumi-kernel`) ships zero cloud SDK code, so the operator chooses
which provider packages to attach to
`createPaaSApp({ kindAliases, plugins: [...] })`.

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import {
  gcpCloudRunWebServiceProvider,
  gcpCloudSqlPostgresProvider,
  gcpGcsObjectStoreProvider,
} from "@takos/takosumi-gcp-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    gcpCloudRunWebServiceProvider({
      project: env.GCP_PROJECT,
      region: env.GCP_REGION,
    }),
    gcpGcsObjectStoreProvider({ project: env.GCP_PROJECT }),
    gcpCloudSqlPostgresProvider({
      project: env.GCP_PROJECT,
      region: env.GCP_REGION,
    }),
  ],
});
```

## Exports

| Factory                         | Kind URI                                     |
| ------------------------------- | -------------------------------------------- |
| `gcpCloudRunWebServiceProvider` | `https://takosumi.com/kinds/v1/web-service`  |
| `gcpGcsObjectStoreProvider`     | `https://takosumi.com/kinds/v1/object-store` |
| `gcpCloudSqlPostgresProvider`   | `https://takosumi.com/kinds/v1/postgres`     |

`gcpCloudRunWorkerProvider` remains as a deprecated compatibility alias for
`gcpCloudRunWebServiceProvider`.

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — shape
  provider host the factories delegate to.
