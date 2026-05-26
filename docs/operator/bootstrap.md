# Reference Bootstrap {#operator-bootstrap}

::: info
内部設計メモ public contract は [Installer API](../reference/installer-api.md) を参照。[Operator Overview](./index.md) から始めてください。
:::

このページは reference Takosumi 実装の bootstrap を設定します。この実装では kind を実行環境に接続する設定を `kindAliases` と reference adapter array (`plugins` option) として `createPaaSApp()` に渡します。

- `kindAliases`: short alias → kind URI の解決 map
- `plugins`: reference adapter factory の plain array

credential は runtime-agent / operator host 側に置く。 Takosumi 互換の実装は別の接続方式を使えます。

## 最小例

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import {
  dockerComposeWebServiceProvider,
} from "@takos/takosumi-plugin-web-service-docker-compose";
import { dockerPostgresProvider } from "@takos/takosumi-plugin-postgres-docker";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    dockerPostgresProvider({
      hostBinding: "127.0.0.1",
    }),
    dockerComposeWebServiceProvider({
      hostBinding: "127.0.0.1",
    }),
  ],
});
```

サーバー起動:

```ts
Deno.serve({ port: 8788 }, app.fetch);
```

CLI (`takosumi server`) は stock dev/reference entrypoint です。カスタム provider を使うなら TypeScript bootstrap を直接書く。

## Provider package entrypoints

reference provider adapter factory は provider / backend ごとの package の named export として公開されます。operator は必要な外部 system の package だけを install します。

- `@takos/takosumi-cloudflare-providers`
- `@takos/takosumi-aws-providers`
- `@takos/takosumi-gcp-providers`
- `@takos/takosumi-kubernetes-providers`
- `@takos/takosumi-deno-deploy-providers`
- `@takos/takosumi-plugin-web-service-docker-compose`
- `@takos/takosumi-plugin-web-service-systemd`
- `@takos/takosumi-plugin-object-store-minio`
- `@takos/takosumi-plugin-object-store-filesystem`
- `@takos/takosumi-plugin-postgres-docker`
- `@takos/takosumi-plugin-gateway-coredns`

## Reference provider inventory examples

| group             | provider ids                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| AWS               | `@takos/aws-s3`, `@takos/aws-fargate`, `@takos/aws-rds`, `@takos/aws-route53`                                                                                                        |
| GCP               | `@takos/gcp-gcs`, `@takos/gcp-cloud-run`, `@takos/gcp-cloud-sql`                                                                                                                     |
| Cloudflare        | `@takos/cloudflare-r2`, `@takos/cloudflare-container`, `@takos/cloudflare-workers`, `@takos/cloudflare-dns`                                                                          |
| Kubernetes        | `@takos/kubernetes-deployment`                                                                                                                                                       |
| External adapters | `@takos/filesystem-object-store`, `@takos/minio-object-store`, `@takos/docker-compose-web-service`, `@takos/systemd-web-service`, `@takos/docker-postgres`, `@takos/coredns-gateway` |
| Deno Deploy       | `@takos/deno-deploy`                                                                                                                                                                 |

各 factory は該当 provider / adapter package の named export として取得します。operator は必要な package だけを別 install します。

## Runtime-agent との対応

下表の `provider id` は operator wiring 由来の安定 id です。runtime-agent の connector 名は実行側の実装詳細で、operator は agent boot 時に必要な credential / local path を設定します。

| provider id                         | runtime-agent connector の例    |
| ----------------------------------- | ------------------------------- |
| `@takos/aws-fargate`                | AWS ECS / Fargate connector     |
| `@takos/gcp-cloud-run`              | GCP Cloud Run connector         |
| `@takos/cloudflare-container`       | Cloudflare Container connector  |
| `@takos/kubernetes-deployment`      | Kubernetes deployment connector |
| `@takos/docker-compose-web-service` | Docker Compose connector        |
| `@takos/docker-postgres`            | Docker Postgres connector       |
| `@takos/deno-deploy`                | Deno Deploy connector           |

## Local Substrate の最小構成 {#local-substrate-minimal}

開発機 1 台で Docker Compose / filesystem / Docker Postgres adapter を使う最小例:

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import {
  dockerComposeWebServiceProvider,
} from "@takos/takosumi-plugin-web-service-docker-compose";
import {
  filesystemObjectStoreProvider,
} from "@takos/takosumi-plugin-object-store-filesystem";
import { dockerPostgresProvider } from "@takos/takosumi-plugin-postgres-docker";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    filesystemObjectStoreProvider({}),
    dockerComposeWebServiceProvider({}),
    dockerPostgresProvider({}),
  ],
});
```

この構成では Manifest の reference component kind alias を external adapter に解決します。public ingress を扱う distribution は、`gateway` kind を提供する provider adapter を同じ reference adapter array (`plugins` option) に追加します。 `dockerComposeWebServiceProvider` と `systemdWebServiceProvider` はどちらも `web-service` kind を提供します。1 つの operator の設定で両方を有効にする場合は、Space policy / provider selector で一意に解決できるようにします。最小構成では片方だけを選びます。

## 関連ページ

- [Operator-managed 運用](./operator-managed.md)
- [Provider Implementations](../reference/providers.md)
- [Reference Runtime-Agent Execution Surface](../reference/runtime-agent-api.md)
