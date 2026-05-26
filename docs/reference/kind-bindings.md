# Kind Binding Implementations {#kind-binding-implementations}

::: info
Public contract は [Installer API](./installer-api.md) と [Manifest](./manifest.md) です。このページは reference kernel が kind を実体化する方法を説明します。
:::

Takosumi の component は `kind`、`spec`、`publish`、`listen` だけを持ちます。operator は `kindAliases` で alias を kind URI に解決し、その kind URI を実体化する implementation binding を選びます。

Reference kernel では、その binding を `KernelPlugin` として `createPaaSApp({ kindAliases, plugins })` に渡します。`plugins` は reference implementation の plain-array adapter 方式です。仕様上は、同じ kind URI を native controller、static registry、workflow engine、SaaS adapter などに bind しても構いません。

Portable descriptor package は `takosumi/`、backend-specific native plugin package は `takosumi-plugins/` が所有します。どちらも public package 名は `@takos/takosumi-kind-*` です。

## Portable kind と native kind

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

`worker` は portable kind alias の例です。operator が `worker` を `cloudflare-worker` に map すれば Cloudflare Workers で動き、`deno-deploy-worker` に map すれば Deno Deploy で動きます。native 機能や backend 固有 field が必要な component は、最初から `cloudflare-worker` や `aws-rds-postgres` のような native kind を書きます。

manifest に `provider` field はありません。backend の違いは `kind` と operator binding で表します。

## Reference kernel attach

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

const { app } = await createPaaSApp({
  kindAliases: {
    worker: WORKER_KIND,
    "object-store": STORE_KIND,
  },
  plugins: [
    cloudflareWorkerPlugin({ accountId }),
    awsS3ObjectStorePlugin({ region: "us-east-1" }),
  ],
});
```

Each factory returns a `KernelPlugin`. The plugin advertises concrete kind URIs through `provides[]`. If no plugin provides the resolved kind URI, dry-run/apply fails before resource side effects. If two plugins provide the same URI, bootstrap fails unless the operator distribution adds a higher-level selection rule outside the core reference array.

## Selection flow

1. Resolve `Component.kind` through `kindAliases`; absolute URIs are already resolved.
2. Load the descriptor metadata for that kind if the operator uses descriptor validation.
3. Validate kind-owned `spec`, `publish`, and `listen` compatibility before side effects.
4. Pick exactly one implementation binding for the resolved kind URI.
5. Run the selected binding and record non-secret outputs in Deployment evidence.

Capability names are open strings used by operator tooling and dashboards. Concrete quotas, credentials, lifecycle limits, and native feature support belong to the kind package docs or the operator profile that enables the package.

## Source roots

- `packages/contract/src/plugin.ts` — `KernelPlugin` / materializer interface.
- `takosumi/packages/kind-*/spec/kind.jsonld` — portable package-owned kind descriptors.
- `takosumi-plugins/packages/kind-*/spec/kind.jsonld` — native package-owned kind descriptors.
- `takosumi-plugins/packages/kind-*/mod.ts` — native descriptor constants and reference adapter factories.
- `takosumi/packages/runtime-agent/src/connectors/` — generic `Connector` interface, registry, and resilience wrapper.
- `takosumi-plugins/packages/runtime-agent-connectors/` — reference concrete connector implementations used by operator distributions.

## Related pages

- [Kind Packages](./kind-packages.md)
- [Reference Adapter Loading](./plugin-loading.md)
- [Connector Guide](./connector-contract.md)
