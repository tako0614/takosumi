# Kind Binding Implementations {#kind-binding-implementations}

::: info
The public contract is [Installer API](./installer-api.md) plus [Manifest](./manifest.md). This page explains how the reference kernel materializes a selected kind.
:::

Takosumi components contain `kind`, `spec`, `connect`, and `listen`. The operator resolves `kind` through `kindAliases` or an absolute URI, then chooses the implementation binding that can materialize that resolved kind URI. Same-manifest dependencies resolve through `connect.<binding>.output`; platform services and external publications resolve through exact `listen.<binding>.path` or discovery with `listen.<binding>.kind` and labels.

In the reference kernel, that binding is a `KernelPlugin` passed to `createPaaSApp({ kindAliases, plugins })`. The `plugins` array is the reference implementation's adapter-loading mechanism. A compatible implementation may bind the same kind URI with a native controller, static registry, workflow engine, or SaaS adapter.

Portable descriptor packages live in `takosumi/`. Backend-specific native kind packages live in `takosumi-plugins/`. Both publish as `@takos/takosumi-kind-*`.

## Portable And Native Kinds

```yaml
components:
  api:
    kind: worker
    spec:
      entrypoint: src/worker.ts

  db:
    kind: aws-rds-postgres
    spec:
      version: "16"
      size: small
```

`worker` is an example portable alias. The resolved kind URI owns the `spec` schema, output slots, and connection compatibility. If `worker` resolves to `https://takosumi.com/kinds/v1/worker`, the operator attaches a binding that provides that portable URI. If an alias resolves to a native URI such as `https://takosumi.com/kinds/v1/cloudflare-worker`, the component uses that native schema.

Use native kinds such as `cloudflare-worker` or `aws-rds-postgres` when the manifest needs backend-specific fields. To keep a manifest portable, resolve the alias to the portable URI and attach a binding that provides that portable URI internally. Do not add a `provider` selector to the manifest.

## Reference Kernel Attach

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import {
  cloudflareWorkerPlugin,
  KIND_URI as WORKER_KIND,
} from "@takos/takosumi-kind-cloudflare-worker";
import {
  awsS3ObjectStorePlugin,
  KIND_URI as STORE_KIND,
} from "@takos/takosumi-kind-aws-s3-object-store";

const workerLifecycle = createCloudflareWorkersLifecycleClient({ accountId });
const objectStoreLifecycle = createAwsS3LifecycleClient({
  region: "us-east-1",
});

const { app } = await createPaaSApp({
  kindAliases: {
    "cloudflare-worker": WORKER_KIND,
    "aws-s3-object-store": STORE_KIND,
  },
  plugins: [
    cloudflareWorkerPlugin({ accountId, lifecycle: workerLifecycle }),
    awsS3ObjectStorePlugin({
      region: "us-east-1",
      lifecycle: objectStoreLifecycle,
    }),
  ],
});
```

Each factory returns a `KernelPlugin`. The plugin advertises supported kind URIs through `provides[]`. If no plugin provides the resolved kind URI, dry-run/apply fails before resource side effects. If two plugins provide the same URI, bootstrap fails unless the operator distribution adds a selection rule outside the core reference array.

## Selection Flow

1. Resolve `Component.kind` through `kindAliases`; absolute URIs are already resolved.
2. Load descriptor metadata if the operator uses descriptor validation.
3. Validate kind-owned `spec`, output slots, and `connect` output ref / `listen.path` / `listen.kind` compatibility before side effects.
4. Pick exactly one implementation binding for the resolved kind URI.
5. Run the selected binding and record non-secret outputs in Deployment evidence.

Capability names are open strings for operator tooling and dashboards. Concrete quotas, credentials, lifecycle limits, and native feature support belong to the kind package docs or the operator distribution that enables the package.

## Source Roots

- `packages/contract/src/plugin.ts` — `KernelPlugin` and materializer interface.
- `takosumi/packages/kind-*/spec/kind.jsonld` — portable package-owned kind descriptors.
- `takosumi-plugins/packages/kind-*/spec/kind.jsonld` — native package-owned kind descriptors; JSON-LD is catalog metadata, not a runtime plugin requirement.
- `takosumi-plugins/packages/kind-*/mod.ts` — native descriptor constants and reference adapter factories.
- `takosumi/packages/runtime-agent/src/connectors/` — generic connector interface, registry, and resilience wrapper.
- `takosumi-plugins/packages/runtime-agent-connectors/` — concrete connector implementations used by operator distributions.

## Related Pages

- [Kind Packages](./kind-packages.md)
- [Reference Adapter Loading](./plugin-loading.md)
- [Official Catalog](./catalog.md)
