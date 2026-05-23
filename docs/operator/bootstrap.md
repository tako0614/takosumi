# オペレーターブートストラップ {#operator-bootstrap}

> このページでわかること: Takosumi reference kernel に provider implementation
> adapter と kind alias map を attach する初期設定の手順。

reference operator-facing entry は **`createPaaSApp({ kindAliases, plugins })`**
です。各 provider adapter factory は `KernelPlugin` を返します。cloud credential
/ SDK code は runtime-agent の env または operator host 側に置き、reference
bootstrap では `kindAliases` と provider `plugins` を kernel に渡します。
`worker` などの short alias も operator config で渡します。

source: per-cloud provider package
([`packages/cloudflare-providers/src/`](https://github.com/tako0614/takosumi/tree/main/packages/cloudflare-providers/src)
/
[`packages/aws-providers/src/`](https://github.com/tako0614/takosumi/tree/main/packages/aws-providers/src)
/
[`packages/gcp-providers/src/`](https://github.com/tako0614/takosumi/tree/main/packages/gcp-providers/src)
/
[`packages/kubernetes-providers/src/`](https://github.com/tako0614/takosumi/tree/main/packages/kubernetes-providers/src)
/
[`packages/deno-deploy-providers/src/`](https://github.com/tako0614/takosumi/tree/main/packages/deno-deploy-providers/src)
/
[`packages/selfhost-providers/src/`](https://github.com/tako0614/takosumi/tree/main/packages/selfhost-providers/src))
— reference provider adapter factory (`<kind>-<provider>.ts` per pair)。

credential / SDK boundary は
[Concepts § Architecture](/getting-started/concepts#architecture-kernel-runtime-agent)
参照。 factory から得た reference adapter は runtime-agent に lifecycle envelope
(apply / destroy / describe) を POST するだけ。

## 最小例

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import { awsS3ObjectStoreProvider } from "@takos/takosumi-aws-providers";
import { cloudflareWorkerProvider } from "@takos/takosumi-cloudflare-providers";
import { selfhostPostgresProvider } from "@takos/takosumi-selfhost-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    cloudflareWorkerProvider({
      accountId: Deno.env.get("CLOUDFLARE_ACCOUNT_ID")!,
    }),
    awsS3ObjectStoreProvider({
      region: Deno.env.get("AWS_REGION")!,
    }),
    selfhostPostgresProvider({
      dockerSocket: "/var/run/docker.sock",
    }),
  ],
});
```

operator は必要な provider adapter factory だけを array に並べて attach し、
cloud credential は runtime-agent の connector env または operator host
側で管理する。 reference kernel が見るのは起動時に渡された `kindAliases` と
`plugins` だけです。

## Reference provider 数

| group       | provider ids                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS         | `@takos/aws-s3`, `@takos/aws-fargate`, `@takos/aws-rds`, `@takos/aws-route53`                                                                                             |
| GCP         | `@takos/gcp-gcs`, `@takos/gcp-cloud-run`, `@takos/gcp-cloud-sql`, `@takos/gcp-cloud-dns`                                                                                  |
| Cloudflare  | `@takos/cloudflare-r2`, `@takos/cloudflare-container`, `@takos/cloudflare-workers`, `@takos/cloudflare-dns`                                                               |
| Azure       | external connector example (reference package は未定義)                                                                                                                   |
| Kubernetes  | `@takos/kubernetes-deployment`                                                                                                                                            |
| Selfhost    | `@takos/selfhost-filesystem`, `@takos/selfhost-minio`, `@takos/selfhost-docker-compose`, `@takos/selfhost-systemd`, `@takos/selfhost-postgres`, `@takos/selfhost-coredns` |
| Deno Deploy | `@takos/deno-deploy`                                                                                                                                                      |

各 factory は該当 cloud provider package
(`@takos/takosumi-{cloudflare,aws,gcp,kubernetes,deno-deploy,selfhost}-providers`)
の named export として取得する (例: `cloudflareWorkerProvider` は
`@takos/takosumi-cloudflare-providers`、 `awsFargateWebServiceProvider` は
`@takos/takosumi-aws-providers`、 `selfhostFilesystemObjectStoreProvider` は
`@takos/takosumi-selfhost-providers` から)。 operator は必要な cloud の package
だけを別 install する。

## Runtime-agent との対応

下表の `provider id` は reference kernel-side `KernelPlugin` adapter が
`Component.kind` を materialize する際の安定 id で、 **operator wiring 由来** (=
operator が `createPaaSApp({ kindAliases, plugins })` に attach した adapter
factory が宣言する id) です。これは
[connector-contract.md](../reference/connector-contract.md) で言う **Connector
consumer plugin** (= Connector の下流 consumer) に相当する。 runtime-agent の
connector 名 (右側) は実装詳細で、 operator は agent boot 時に必要な connector
credential / local path を設定する。

| provider id (operator wiring 由来、= reference adapter / Connector consumer) | runtime-agent connector の例    |
| ---------------------------------------------------------------------------- | ------------------------------- |
| `@takos/aws-fargate`                                                         | AWS ECS / Fargate connector     |
| `@takos/gcp-cloud-run`                                                       | GCP Cloud Run connector         |
| `@takos/cloudflare-container`                                                | Cloudflare Container connector  |
| `@takos/kubernetes-deployment`                                               | Kubernetes deployment connector |
| `@takos/selfhost-docker-compose`                                             | docker-compose connector        |
| `@takos/selfhost-postgres`                                                   | local Docker Postgres connector |
| `@takos/deno-deploy`                                                         | Deno Deploy connector           |

## Selfhosted のみの最小構成 {#selfhosted-only-な最小構成}

開発機 1 台で全部 selfhosted で動かす最小例:

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import {
  selfhostCoreDnsCustomDomainProvider,
  selfhostDockerComposeWebServiceProvider,
  selfhostFilesystemObjectStoreProvider,
  selfhostMinioObjectStoreProvider,
  selfhostPostgresProvider,
  selfhostSystemdWebServiceProvider,
} from "@takos/takosumi-selfhost-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    selfhostFilesystemObjectStoreProvider({}),
    selfhostMinioObjectStoreProvider({ endpoint: "http://localhost:9000" }),
    selfhostDockerComposeWebServiceProvider({}),
    selfhostSystemdWebServiceProvider({}),
    selfhostPostgresProvider({}),
    selfhostCoreDnsCustomDomainProvider({}),
  ],
});
```

この構成では AppSpec の reference component kind alias を self-host provider
に解決する。

## 関連ページ

- [Provider Implementations](../reference/providers.md)
- [Provider package examples](../reference/provider-packages.md) — reference
  provider package と capability metadata の例
- [Runtime-agent API](../reference/runtime-agent-api.md) — agent lifecycle
  envelope
- [Reference Kind Descriptors](../reference/kind-registry.md#reference-component-kinds)
  — reference kind ごとの outputs と capabilities
- [AppSpec](../reference/app-spec.md) — operator が apply する `.takosumi.yml`
  の syntax
- [Extending](/extending) — 新 provider 追加時の reference adapter 作り方
