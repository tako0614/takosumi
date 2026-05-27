# Kind Binding 実装 {#kind-binding-implementations}

::: info
Public contract は [Installer API](./installer-api.md) と [manifest](./manifest.md) です。このページは reference kernel が選択済み kind をどう実体化するかを説明します。
:::

Takosumi component は `kind`、`spec`、`connect`、`listen` を持ちます。operator は `kindAliases` または absolute URI で `kind` を kind URI に解決し、その kind URI を実体化できる implementation binding を選びます。same-manifest dependency は `connect.<binding>.output`、platform service / external publication は exact target なら `listen.<binding>.path`、discovery なら `listen.<binding>.kind` + labels で解決します。

Reference kernel では、その binding を `KernelPlugin` として `createPaaSApp({ kindAliases, plugins })` に渡します。`plugins` array は reference implementation の adapter loading 方式です。互換 implementation は同じ kind URI を native controller、static registry、workflow engine、SaaS adapter などへ bind できます。

Portable descriptor package は `takosumi/`、backend-specific native kind package は `takosumi-plugins/` が所有します。どちらも public package 名は `@takos/takosumi-kind-*` です。

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

`worker` は portable alias の例です。解決後の kind URI が `spec` schema、output slot、connection compatibility を所有します。`worker` を `https://takosumi.com/kinds/v1/worker` に解決する場合、operator はその portable URI を提供する binding を attach します。alias を `https://takosumi.com/kinds/v1/cloudflare-worker` のような native URI に解決する場合、その component は native schema を使います。

Backend 固有 field が必要な manifest は `cloudflare-worker` や `aws-rds-postgres` のような native kind を使います。manifest を portable に保つ場合は、native URI に alias するのではなく、portable URI を提供する binding を内部で選びます。manifest に `provider` selector はありません。

## Reference kernel への attach

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

各 factory は `KernelPlugin` を返します。`workerLifecycle` や `objectStoreLifecycle` は operator distribution が用意する backend lifecycle client です。plugin は対応する kind URI を `provides[]` で宣言します。解決済み kind URI を提供する plugin がなければ、dry-run/apply は resource side effect の前に失敗します。同じ URI を複数 plugin が提供する場合、operator distribution が core reference array の外で selection rule を追加しない限り bootstrap で失敗します。

## Selection flow

1. `Component.kind` を `kindAliases` で解決する。absolute URI は解決済みとして扱う。
2. operator が descriptor validation を使う場合、その kind の descriptor metadata を読む。
3. side effect の前に、kind-owned `spec`、output slot、`connect` output ref / `listen.path` / `listen.kind` compatibility を検証する。
4. 解決済み kind URI に対して implementation binding を 1 つ選ぶ。
5. 選択した binding を実行し、non-secret output を Deployment evidence に記録する。

Capability name は operator tooling / dashboard のための open string です。quota、credential、lifecycle limit、native feature support は kind package docs またはその package を有効にする operator distribution が説明します。

## Source roots

- `packages/contract/src/plugin.ts` — `KernelPlugin` / materializer interface。
- `takosumi/packages/kind-*/spec/kind.jsonld` — portable package-owned kind descriptor。
- `takosumi-plugins/packages/kind-*/spec/kind.jsonld` — native package-owned kind descriptor。JSON-LD は catalog / schema metadata で、runtime plugin requirement ではない。
- `takosumi-plugins/packages/kind-*/mod.ts` — native descriptor constant と reference adapter factory。
- `takosumi/packages/runtime-agent/src/connectors/` — generic connector interface、registry、resilience wrapper。
- `takosumi-plugins/packages/runtime-agent-connectors/` — operator distribution が使える concrete connector implementation。

## 関連ページ

- [Kind Packages](./kind-packages.md)
- [Reference Adapter Loading](./plugin-loading.md)
- [Takosumi 公式カタログ仕様](./catalog.md)
