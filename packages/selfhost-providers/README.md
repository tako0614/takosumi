# @takos/takosumi-selfhost-providers

Self-host-backed reference `KernelPlugin` adapter factories that can bind
selected takosumi.com kind URIs (`web-service` / `object-store` / `postgres`) in
the reference kernel. Provides a credential-free baseline for Takosumi operators
who want to run the kernel without any cloud account.

Operators import this package explicitly — Takosumi core
(`@takos/takosumi-kernel`) ships zero cloud / self-host SDK code, so the
operator chooses which provider packages to attach to the reference adapter
array (`createPaaSApp({ kindAliases, plugins: [...] })`).

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import {
  selfhostDockerComposeWebServiceProvider,
  selfhostFilesystemObjectStoreProvider,
  selfhostPostgresProvider,
} from "@takos/takosumi-selfhost-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    selfhostDockerComposeWebServiceProvider(),
    selfhostFilesystemObjectStoreProvider({
      rootDir: "/var/lib/takos/object-store",
    }),
    selfhostPostgresProvider(),
  ],
});
```

## Exports

| Factory                                   | Kind URI                                     |
| ----------------------------------------- | -------------------------------------------- |
| `selfhostDockerComposeWebServiceProvider` | `https://takosumi.com/kinds/v1/web-service`  |
| `selfhostSystemdWebServiceProvider`       | `https://takosumi.com/kinds/v1/web-service`  |
| `selfhostMinioObjectStoreProvider`        | `https://takosumi.com/kinds/v1/object-store` |
| `selfhostFilesystemObjectStoreProvider`   | `https://takosumi.com/kinds/v1/object-store` |
| `selfhostPostgresProvider`                | `https://takosumi.com/kinds/v1/postgres`     |

`selfhostDockerComposeWorkerProvider` and `selfhostSystemdWorkerProvider` are
alternate exports for the web-service factories.

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — official
  catalog descriptor helpers and reference adapter helpers.
