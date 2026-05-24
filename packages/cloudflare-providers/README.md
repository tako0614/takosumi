# @takos/takosumi-cloudflare-providers

Cloudflare-backed reference `KernelPlugin` adapter factories for takosumi.com
reference component kinds (`worker` / `object-store` / `gateway`).
Operators import this package explicitly when they want Cloudflare coverage —
Takosumi core (`@takos/takosumi-kernel`) ships zero cloud SDK code, so the
operator chooses which provider packages to attach to the reference adapter
array (`createPaaSApp({ kindAliases, plugins: [...] })`).

## Install

```typescript
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import {
  cloudflareCustomDomainProvider,
  cloudflareR2ObjectStoreProvider,
  cloudflareWorkerProvider,
} from "@takos/takosumi-cloudflare-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    cloudflareWorkerProvider({ accountId: env.CLOUDFLARE_ACCOUNT_ID }),
    cloudflareR2ObjectStoreProvider({ accountId: env.CLOUDFLARE_ACCOUNT_ID }),
    cloudflareCustomDomainProvider({ zoneId: env.CLOUDFLARE_ZONE_ID }),
  ],
});
```

Cloudflare API tokens are configured on the runtime-agent connector environment
or operator host. Provider factory arguments stay limited to non-secret selector
settings such as account id or zone id.

## Exports

| Factory                           | Kind URI                                      |
| --------------------------------- | --------------------------------------------- |
| `cloudflareWorkerProvider`        | `https://takosumi.com/kinds/v1/worker`        |
| `cloudflareR2ObjectStoreProvider` | `https://takosumi.com/kinds/v1/object-store`  |
| `cloudflareCustomDomainProvider`  | `https://takosumi.com/kinds/v1/gateway` |

Each factory returns a reference `KernelPlugin` adapter (see
[`@takos/takosumi-contract/plugin`](https://jsr.io/@takos/takosumi-contract)).
Default options pick an in-memory lifecycle client suitable for tests; pass
`{ lifecycle: ... }` in production to wire the runtime-agent-backed client.

## See also

- [`@takos/takosumi-kernel`](https://jsr.io/@takos/takosumi-kernel)
- [`@takos/takosumi-plugins`](https://jsr.io/@takos/takosumi-plugins) —
  reference kind descriptors and adapter helpers.
