# @takos/takosumi

Umbrella package for the Takosumi contract, installer, kernel, CLI,
runtime-agent, and portable official kind descriptors.

Core exports:

- `@takos/takosumi/contract`
- `@takos/takosumi/installer`
- `@takos/takosumi/kernel`
- `@takos/takosumi/runtime-agent`
- `@takos/takosumi/cli`
- `@takos/takosumi/kinds`

Portable kind descriptor packages remain individually installable as
`@takos/takosumi-kind-<alias>`. Backend-specific native plugins live in the
separate `takosumi-plugins` repository and should be imported directly by the
operator distribution that enables them.

```ts
import { KIND_DESCRIPTOR, KIND_URI } from "@takos/takosumi-kind-worker";

console.log(KIND_URI, KIND_DESCRIPTOR);
```

The portable kind descriptor packages currently cover worker, web-service,
postgres, sqlite, object-store, kv-store, message-queue, vector-store, and
gateway shapes.
