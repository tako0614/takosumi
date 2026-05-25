# Reference Kernel Bootstrap {#operator-bootstrap}

このページは reference Takosumi kernel implementation の bootstrap
を設定します。この implementation では provider binding を `kindAliases` と
reference adapter array (`plugins` option) として `createPaaSApp()` に渡します。

- `kindAliases`: short alias → kind URI の解決 map
- `plugins`: reference adapter factory の plain array

credential は runtime-agent / operator host 側に置く。 Takosumi-compatible
implementation は別の implementation binding mechanism を使えます。

## 最小例

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import {
  selfhostDockerComposeWebServiceProvider,
  selfhostPostgresProvider,
} from "@takos/takosumi-selfhost-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    selfhostPostgresProvider({
      hostBinding: "127.0.0.1",
    }),
    selfhostDockerComposeWebServiceProvider({
      hostBinding: "127.0.0.1",
    }),
  ],
});
```

サーバー起動:

```ts
Deno.serve({ port: 8788 }, app.fetch);
```

CLI (`takosumi server`) は stock dev/reference-kernel entrypoint です。カスタム
provider を使うなら TypeScript bootstrap を直接書く。

## Provider package entrypoints

reference provider adapter factory は per-cloud provider package の named export
として公開されます。operator は必要な cloud の package だけを install します。

- `@takos/takosumi-cloudflare-providers`
- `@takos/takosumi-aws-providers`
- `@takos/takosumi-gcp-providers`
- `@takos/takosumi-kubernetes-providers`
- `@takos/takosumi-deno-deploy-providers`
- `@takos/takosumi-selfhost-providers`

## Reference provider inventory examples

| group       | provider ids                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS         | `@takos/aws-s3`, `@takos/aws-fargate`, `@takos/aws-rds`, `@takos/aws-route53`                                                                  |
| GCP         | `@takos/gcp-gcs`, `@takos/gcp-cloud-run`, `@takos/gcp-cloud-sql`                                                                               |
| Cloudflare  | `@takos/cloudflare-r2`, `@takos/cloudflare-container`, `@takos/cloudflare-workers`, `@takos/cloudflare-dns`                                    |
| Kubernetes  | `@takos/kubernetes-deployment`                                                                                                                 |
| Selfhost    | `@takos/selfhost-filesystem`, `@takos/selfhost-minio`, `@takos/selfhost-docker-compose`, `@takos/selfhost-systemd`, `@takos/selfhost-postgres` |
| Deno Deploy | `@takos/deno-deploy`                                                                                                                           |

各 factory は該当 cloud provider package
(`@takos/takosumi-{cloudflare,aws,gcp,kubernetes,deno-deploy,selfhost}-providers`)
の named export として取得します。operator は必要な cloud の package だけを別
install します。

## Runtime-agent との対応

下表の `provider id` は operator wiring 由来の安定 id です。runtime-agent の
connector 名は実行側の実装詳細で、operator は agent boot 時に必要な credential /
local path を設定します。

| provider id                      | runtime-agent connector の例    |
| -------------------------------- | ------------------------------- |
| `@takos/aws-fargate`             | AWS ECS / Fargate connector     |
| `@takos/gcp-cloud-run`           | GCP Cloud Run connector         |
| `@takos/cloudflare-container`    | Cloudflare Container connector  |
| `@takos/kubernetes-deployment`   | Kubernetes deployment connector |
| `@takos/selfhost-docker-compose` | docker-compose connector        |
| `@takos/selfhost-postgres`       | local Docker Postgres connector |
| `@takos/deno-deploy`             | Deno Deploy connector           |

## Selfhosted のみの最小構成 {#selfhosted-only-minimal}

開発機 1 台で全部 selfhosted に寄せる最小例:

```ts
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
    selfhostFilesystemObjectStoreProvider({}),
    selfhostDockerComposeWebServiceProvider({}),
    selfhostPostgresProvider({}),
  ],
});
```

この構成では AppSpec の reference component kind alias を self-host provider に
解決します。public ingress を扱う distribution は、`gateway` kind を提供する
provider adapter を同じ reference adapter array (`plugins` option)
に追加します。 `selfhostDockerComposeWebServiceProvider` と
`selfhostSystemdWebServiceProvider` はどちらも `web-service` kind
を提供します。1 つの operator profile で両方を 有効にする場合は、Space policy /
provider selector で一意に解決できるようにし
ます。最小構成では片方だけを選びます。

## 関連ページ

- [セルフホスト運用](./self-host.md)
- [Provider Implementations](../reference/providers.md)
- [Reference Runtime-Agent Execution Surface](../reference/runtime-agent-api.md)
