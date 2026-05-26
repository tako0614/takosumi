# Reference Adapter Loading (`plugins` option) {#plugin-loading}

::: info
This is reference-kernel implementation documentation. Takosumi-compatible implementations can bind kind URIs without using this plugin mechanism.
:::

The reference kernel accepts a plain array of `KernelPlugin` objects through `createPaaSApp({ kindAliases, plugins })`. Each adapter declares the kind URIs it can materialize in `provides[]`.

Backend-specific reference adapters live in the separate `takosumi-plugins` repository. The Takosumi core repository keeps the plugin interface and portable descriptors, but does not bundle concrete cloud or host bindings into the umbrella package.

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import {
  cloudflareWorkerPlugin,
  KIND_URI as WORKER_KIND,
} from "@takos/takosumi-kind-cloudflare-worker";

const { app } = await createPaaSApp({
  kindAliases: { worker: WORKER_KIND },
  plugins: [cloudflareWorkerPlugin({ accountId })],
});
```

`kindAliases` is operator policy. A short alias such as `worker` can point to a portable kind URI or directly to a native kind URI such as `https://takosumi.com/kinds/v1/cloudflare-worker`.

## Boot validation

- unresolved aliases fail before apply
- adapter entries with empty `provides[]` fail at bootstrap
- duplicate adapters for the same kind URI fail at bootstrap
- an apply whose kind URI has no adapter fails before side effects

Package acquisition, lockfiles, vendoring, private registries, and supply-chain policy belong to the operator distribution.

## Relation to JSON-LD

JSON-LD descriptor files publish kind vocabulary and metadata. The reference adapter array does not load JSON-LD as executable code. A compatible implementation may compile, mirror, or vendor descriptor metadata and still use a different implementation binding mechanism.

## Related pages

- [Kind Packages](./kind-packages.md)
- [Kind Binding Implementations](./kind-bindings.md)
- [Supply Chain Trust](./supply-chain-trust.md)
