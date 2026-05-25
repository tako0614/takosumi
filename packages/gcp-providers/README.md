# @takos/takosumi-gcp-providers

GCP-backed reference `KernelPlugin` adapter factories that can bind selected takosumi.com kind URIs (`web-service` / `object-store` / `postgres`) in the reference kernel. Operators import this package explicitly when they want GCP coverage — Takosumi core (`@takos/takosumi-kernel`) ships zero cloud SDK code, so the operator chooses which provider packages to attach to the reference adapter array (`createPaaSApp({ kindAliases, plugins: [...] })`).

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
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

GCP credentials are configured on the runtime-agent connector environment or operator host. Provider factory arguments stay limited to non-secret selector settings such as project id or region.

## Exports

| Factory                         | Kind URI                                     |
| ------------------------------- | -------------------------------------------- |
| `gcpCloudRunWebServiceProvider` | `https://takosumi.com/kinds/v1/web-service`  |
| `gcpGcsObjectStoreProvider`     | `https://takosumi.com/kinds/v1/object-store` |
| `gcpCloudSqlPostgresProvider`   | `https://takosumi.com/kinds/v1/postgres`     |

`gcpCloudRunWorkerProvider` is an alternate export for `gcpCloudRunWebServiceProvider`.

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — official catalog descriptor helpers and reference adapter helpers.
