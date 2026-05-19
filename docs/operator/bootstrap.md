# オペレーターブートストラップ {#operator-bootstrap}

> このページでわかること: kernel に bundled materializer plugin (=
> `KernelPlugin` plain array) を attach する初期設定の手順。

operator-facing entry は **`createPaaSApp({ plugins: [...] })`** の plain array
(= Vite plugin pattern)。 各 plugin factory は `KernelPlugin` を返し、 operator
は env から credential を読んで factory に直接渡す。

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
— bundled `KernelPlugin` factory (`<kind>-<provider>.ts` per pair)。

credential / SDK boundary は
[Concepts § Architecture](/getting-started/concepts#architecture-kernel--runtime-agent)
参照。 factory から得た plugin は runtime-agent に lifecycle envelope (apply /
destroy / describe) を POST するだけ。

## 最小例

```ts
import { createPaaSApp } from "@takos/takosumi-kernel";
import { awsS3ObjectStoreProvider } from "@takos/takosumi-aws-providers";
import { cloudflareWorkerProvider } from "@takos/takosumi-cloudflare-providers";
import { selfhostPostgresProvider } from "@takos/takosumi-selfhost-providers";

const { app } = await createPaaSApp({
  plugins: [
    cloudflareWorkerProvider({
      accountId: Deno.env.get("CLOUDFLARE_ACCOUNT_ID")!,
      apiToken: Deno.env.get("CLOUDFLARE_API_TOKEN")!,
    }),
    awsS3ObjectStoreProvider({
      region: Deno.env.get("AWS_REGION")!,
      accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID")!,
      secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY")!,
    }),
    selfhostPostgresProvider({
      dockerSocket: "/var/run/docker.sock",
    }),
  ],
});
```

旧 `enableAws: true` / `createTakosumiProductionProviders(opts)` switch は
廃止された。 operator は必要な provider factory だけを array に並べて attach
し、 plugin に応じた credential を直接渡す形に統一されている。 kernel は plugin
marketplace / plugin index fetch / signed manifest / port-based plugin host を
持たない。

## Bundled provider 数

| group       | provider ids                                                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS         | `@takos/aws-s3`, `@takos/aws-fargate`, `@takos/aws-rds`, `@takos/aws-route53`                                                                                             |
| GCP         | `@takos/gcp-gcs`, `@takos/gcp-cloud-run`, `@takos/gcp-cloud-sql`, `@takos/gcp-cloud-dns`                                                                                  |
| Cloudflare  | `@takos/cloudflare-r2`, `@takos/cloudflare-container`, `@takos/cloudflare-workers`, `@takos/cloudflare-dns`                                                               |
| Azure       | `@takos/azure-container-apps`                                                                                                                                             |
| Kubernetes  | `@takos/kubernetes-deployment`                                                                                                                                            |
| Selfhost    | `@takos/selfhost-filesystem`, `@takos/selfhost-minio`, `@takos/selfhost-docker-compose`, `@takos/selfhost-systemd`, `@takos/selfhost-postgres`, `@takos/selfhost-coredns` |
| Deno Deploy | `@takos/deno-deploy`                                                                                                                                                      |

各 factory は該当 cloud provider package
(`@takos/takosumi-{cloudflare,aws,gcp,kubernetes,deno-deploy,selfhost}-providers`)
の named export として取得する (例: `cloudflareWorkerProvider` は
`@takos/takosumi-cloudflare-providers`、 `awsFargateWorkerProvider` は
`@takos/takosumi-aws-providers`、 `selfhostFilesystemObjectStoreProvider` は
`@takos/takosumi-selfhost-providers` から)。 operator は必要な cloud の package
だけを別 install する。

## Runtime-agent との対応

下表の `provider id` は kernel-side `KernelPlugin` (= 旧 `ProviderPlugin` を
`kernelPluginFromProviderPlugin` adapter で bridge した materializer factory) が
`Component.kind` を materialize する際の安定 id で、 **operator wiring 由来** (=
operator が `createPaaSApp({ plugins })` に attach した factory が宣言する id)
であり、 AppSpec manifest 由来ではない。 これは
[connector-contract.md](../reference/connector-contract.md) で言う **Connector
consumer plugin** (= Connector の下流 consumer) に相当する。 runtime-agent の
connector 名 (右側) は実装詳細で、 operator は agent boot 時に必要な connector
credential / local path を設定する。

| provider id (operator wiring 由来、= KernelPlugin / Connector consumer) | runtime-agent connector の例    |
| ----------------------------------------------------------------------- | ------------------------------- |
| `@takos/aws-fargate`                                                    | AWS ECS / Fargate connector     |
| `@takos/gcp-cloud-run`                                                  | GCP Cloud Run connector         |
| `@takos/cloudflare-container`                                           | Cloudflare Container connector  |
| `@takos/kubernetes-deployment`                                          | Kubernetes deployment connector |
| `@takos/selfhost-docker-compose`                                        | docker-compose connector        |
| `@takos/selfhost-postgres`                                              | local Docker Postgres connector |
| `@takos/deno-deploy`                                                    | Deno Deploy connector           |

## Selfhosted のみの最小構成 {#selfhosted-only-な最小構成}

開発機 1 台で全部 selfhosted で動かす最小例:

```ts
import { createPaaSApp } from "@takos/takosumi-kernel";
import {
  selfhostCoreDnsCustomDomainProvider,
  selfhostDockerComposeWorkerProvider,
  selfhostFilesystemObjectStoreProvider,
  selfhostMinioObjectStoreProvider,
  selfhostPostgresProvider,
  selfhostSystemdWorkerProvider,
} from "@takos/takosumi-selfhost-providers";

const { app } = await createPaaSApp({
  plugins: [
    selfhostFilesystemObjectStoreProvider({}),
    selfhostMinioObjectStoreProvider({ endpoint: "http://localhost:9000" }),
    selfhostDockerComposeWorkerProvider({}),
    selfhostSystemdWorkerProvider({}),
    selfhostPostgresProvider({}),
    selfhostCoreDnsCustomDomainProvider({}),
  ],
});
```

この構成では AppSpec の portable component kind を self-host provider
に解決する。

## 関連ページ

- [Provider Plugins](../reference/providers.md) — 20 default + 1 opt-in provider
  の実装と capabilities
- [Runtime-agent API](../reference/runtime-agent-api.md) — agent lifecycle
  envelope
- [Kind Catalog](../reference/kind-catalog.md#component-kinds) — kind ごとの
  outputs と capabilities
- [Manifest](/manifest) — operator が apply する manifest の syntax
- [Extending](/extending) — 新 provider 追加時の `KernelPlugin` 作り方
