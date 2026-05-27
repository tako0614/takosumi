# Reference Adapter Loading (`plugins` option) {#plugin-loading}

::: info
This is reference-kernel implementation documentation. Takosumi-compatible implementations can bind kind URIs without using this plugin mechanism.
:::

The reference kernel accepts a plain array of `KernelPlugin` objects through `createPaaSApp({ kindAliases, plugins })`. Each adapter declares the kind URIs it can materialize in `provides[]`.

Backend-specific reference adapters live in the separate `takosumi-plugins` repository. The Takosumi core repository keeps the plugin interface and portable descriptors, but does not bundle concrete cloud or host bindings into the umbrella package.

`component.spec` is descriptor-owned author input. The reference pipeline resolves `connect` output refs and `listen.path` entries into `ctx.resolvedBindings` before `apply()`. Adapters read that context when they need env, mount, or upstream runtime inputs. Native packages should not rely on hidden mutation of `spec` to receive dependency-derived values.

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import {
  cloudflareWorkerPlugin,
  KIND_URI as WORKER_KIND,
} from "@takos/takosumi-kind-cloudflare-worker";

const lifecycle = createCloudflareWorkersLifecycleClient({ accountId });

const { app } = await createPaaSApp({
  kindAliases: { "cloudflare-worker": WORKER_KIND },
  plugins: [cloudflareWorkerPlugin({ accountId, lifecycle })],
});
```

`kindAliases` is operator policy. A short alias can point to a portable kind URI or a native kind URI. The resolved kind URI owns the `spec` schema, output slots, and connection compatibility. Use a portable URI plus a binding that provides that URI for portable manifests. Use a native URI or native alias when the manifest uses backend-specific fields.

## Boot Validation

- unresolved aliases fail before apply
- adapter entries with empty `provides[]` fail at bootstrap
- duplicate adapters for the same kind URI fail at bootstrap
- an apply whose kind URI has no adapter fails before side effects

Package acquisition, lockfiles, vendoring, private registries, and supply-chain policy belong to the operator distribution.

## Relation To JSON-LD

JSON-LD descriptor files publish kind vocabulary and metadata. The reference adapter array does not load JSON-LD as executable code. A compatible implementation may compile, mirror, or vendor descriptor metadata and still use a different implementation binding mechanism.

## Related Pages

- [Kind Packages](./kind-packages.md)
- [Kind Binding Implementations](./kind-bindings.md)
- [Official Type Catalog](./type-catalog.md)
