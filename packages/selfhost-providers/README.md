# @takos/takosumi-selfhost-providers

Self-host-backed `KernelPlugin` factories for the canonical Takosumi component
kinds (`worker` / `object-store` / `postgres`). Provides a credential-free
baseline for Takosumi operators who want to run the kernel without any cloud
account.

Operators import this package explicitly — Takosumi core
(`@takos/takosumi-kernel`) ships zero cloud / self-host SDK code, so the
operator chooses which provider packages to attach to
`createPaaSApp({ plugins: [...] })`.

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel";
import {
  selfhostDockerComposeWorkerProvider,
  selfhostFilesystemObjectStoreProvider,
  selfhostPostgresProvider,
} from "@takos/takosumi-selfhost-providers";

const { app } = await createPaaSApp({
  plugins: [
    selfhostDockerComposeWorkerProvider(),
    selfhostFilesystemObjectStoreProvider({
      rootDir: "/var/lib/takos/object-store",
    }),
    selfhostPostgresProvider(),
  ],
});
```

## Exports

| Factory                                 | Kind URI                                     |
| --------------------------------------- | -------------------------------------------- |
| `selfhostDockerComposeWorkerProvider`   | `https://takosumi.com/kinds/v1/worker`       |
| `selfhostSystemdWorkerProvider`         | `https://takosumi.com/kinds/v1/worker`       |
| `selfhostMinioObjectStoreProvider`      | `https://takosumi.com/kinds/v1/object-store` |
| `selfhostFilesystemObjectStoreProvider` | `https://takosumi.com/kinds/v1/object-store` |
| `selfhostPostgresProvider`              | `https://takosumi.com/kinds/v1/postgres`     |

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) — shape
  provider host the factories delegate to.
