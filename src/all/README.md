# @takos/takosumi

Umbrella package for the Takosumi contract, installer, kernel, CLI, and
runtime-agent — the kind-agnostic framework you import.

Core exports:

- `@takos/takosumi/contract`
- `@takos/takosumi/installer`
- `@takos/takosumi/kernel`
- `@takos/takosumi/runtime-agent`
- `@takos/takosumi/cli`
- `@takos/takosumi/server`

This package ships **no kind code**. The official kind catalog is published
_spec_: portable kind descriptors are JSON-LD served at
`https://takosumi.com/kinds/v1/<name>` (repository source: `docs/kinds/v1/`).
The framework imports none of them — `Component.kind` is an opaque alias/URI
resolved by operator-supplied `kindAliases` and implementation bindings.

Backend-specific native kind descriptors and their `KernelPlugin`
implementations live in the separate `takosumi-plugins` repository and are
attached by the operator distribution that enables them:

```ts
import { createPaaSApp } from "@takos/takosumi/kernel";
import { cloudflareWorkerPlugin } from "@takosjp/takosumi-plugins/kind/cloudflare-worker";

const { app } = createPaaSApp({
  kindAliases: { worker: "https://takosumi.com/kinds/v1/cloudflare-worker" },
  plugins: [cloudflareWorkerPlugin({ lifecycle })],
});
```

The official portable catalog currently covers worker, web-service, postgres,
sqlite, object-store, kv-store, message-queue, vector-store, and gateway shapes.
