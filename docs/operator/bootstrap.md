# オペレーターブートストラップ {#operator-bootstrap}

> このページでわかること: Takosumi reference kernel に kind alias map と
> provider implementation を渡す方法。

Takosumi の public spec は AppSpec / Installation / Deployment と Installer API
です。`createPaaSApp({ kindAliases, plugins })` は Takosumi reference kernel の
起動 API で、operator distribution が採用する implementation wiring です。

reference kernel では、operator は次を起動時に渡します。

- `kindAliases`: `worker` などの short alias を kind URI に解決する map。
- `plugins`: provider adapter factory が返す implementation binding の plain
  array。

cloud credential / SDK code は runtime-agent の env、connector、または operator
host 側に置きます。kernel が見るのは alias map と implementation binding です。

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

operator は必要な provider adapter factory だけを array に並べます。`plugins`
という名前は reference kernel の Vite-like wiring API の名前であり、別の
Takosumi-compatible implementation が同じ仕組みを使う必要はありません。

## Implementation source map

reference provider adapter factories live in per-cloud provider packages:

- [`packages/cloudflare-providers/src/`](https://github.com/tako0614/takosumi/tree/main/packages/cloudflare-providers/src)
- [`packages/aws-providers/src/`](https://github.com/tako0614/takosumi/tree/main/packages/aws-providers/src)
- [`packages/gcp-providers/src/`](https://github.com/tako0614/takosumi/tree/main/packages/gcp-providers/src)
- [`packages/kubernetes-providers/src/`](https://github.com/tako0614/takosumi/tree/main/packages/kubernetes-providers/src)
- [`packages/deno-deploy-providers/src/`](https://github.com/tako0614/takosumi/tree/main/packages/deno-deploy-providers/src)
- [`packages/selfhost-providers/src/`](https://github.com/tako0614/takosumi/tree/main/packages/selfhost-providers/src)

## Reference provider 数

| group       | provider ids                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS         | `@takos/aws-s3`, `@takos/aws-fargate`, `@takos/aws-rds`, `@takos/aws-route53`                                                                                             |
| GCP         | `@takos/gcp-gcs`, `@takos/gcp-cloud-run`, `@takos/gcp-cloud-sql`, `@takos/gcp-cloud-dns`                                                                                  |
| Cloudflare  | `@takos/cloudflare-r2`, `@takos/cloudflare-container`, `@takos/cloudflare-workers`, `@takos/cloudflare-dns`                                                               |
| Kubernetes  | `@takos/kubernetes-deployment`                                                                                                                                            |
| Selfhost    | `@takos/selfhost-filesystem`, `@takos/selfhost-minio`, `@takos/selfhost-docker-compose`, `@takos/selfhost-systemd`, `@takos/selfhost-postgres`, `@takos/selfhost-coredns` |
| Deno Deploy | `@takos/deno-deploy`                                                                                                                                                      |

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
  selfhostSystemdWebServiceProvider,
} from "@takos/takosumi-selfhost-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    selfhostFilesystemObjectStoreProvider({}),
    selfhostDockerComposeWebServiceProvider({}),
    selfhostSystemdWebServiceProvider({}),
    selfhostPostgresProvider({}),
  ],
});
```

この構成では AppSpec の reference component kind alias を self-host provider に
解決します。public ingress を扱う distribution は、`gateway` kind を提供する
provider adapter を同じ `plugins` array に追加します。

## 関連ページ

- [セルフホスト運用](./self-host.md)
- [Provider Implementations](../reference/providers.md)
- [Provider package examples](../reference/provider-packages.md)
- [Reference Plugin Loading](../reference/plugin-loading.md)
- [Runtime-Agent API](../reference/runtime-agent-api.md)
- [Kind Descriptor Examples](../reference/kind-registry.md)
- [AppSpec](../reference/app-spec.md)
