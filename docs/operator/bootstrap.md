# Operator Bootstrap

> このページでわかること: kernel に bundled provider plugin を attach する初期
> 設定の手順 (= `KernelPlugin` plain array)。

operator-facing entry は **`createPaaSApp({ plugins: [...] })`** の plain array
(= Vite plugin pattern)。 各 plugin factory は `KernelPlugin` を返し、 operator
は env から credential を読んで factory に直接渡す。

source:
[`packages/plugins/src/bundled/`](https://github.com/takos-jp/takosumi/tree/main/packages/plugins/src/bundled)
— bundled `KernelPlugin` factory (`<kind>-<provider>.ts` per pair)。

credential / SDK boundary は
[Concepts § Architecture](/getting-started/concepts#architecture-kernel--runtime-agent)
参照。 factory から得た plugin は runtime-agent に lifecycle envelope (apply /
destroy / describe) を POST するだけ。

## 最小例

```ts
import { createPaaSApp } from "@takos/takosumi-kernel";
import {
  awsS3ObjectStoreProvider,
  cloudflareWorkerProvider,
  selfhostPostgresProvider,
} from "@takos/takosumi-plugins/bundled";

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

各 factory は `@takos/takosumi-plugins/bundled` から独立 named export で取得で
きる (例: `cloudflareWorkerProvider`、 `awsFargateWorkerProvider`、
`selfhostFilesystemObjectStoreProvider`)。

## Runtime-agent との対応

provider id は manifest に書く安定した id。 runtime-agent の connector
名は実装詳細で、 operator は agent boot 時に必要な connector credential / local
path を設定する。

| manifest provider id             | runtime-agent connector の例    |
| -------------------------------- | ------------------------------- |
| `@takos/aws-fargate`             | AWS ECS / Fargate connector     |
| `@takos/gcp-cloud-run`           | GCP Cloud Run connector         |
| `@takos/cloudflare-container`    | Cloudflare Container connector  |
| `@takos/kubernetes-deployment`   | Kubernetes deployment connector |
| `@takos/selfhost-docker-compose` | docker-compose connector        |
| `@takos/selfhost-postgres`       | local Docker Postgres connector |
| `@takos/deno-deploy`             | Deno Deploy connector           |

## Selfhosted-only な最小構成

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
} from "@takos/takosumi-plugins/bundled";

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

- [Provider Plugins](/reference/providers) — 20 default + 1 opt-in provider
  の実装と capabilities
- [Runtime-agent API](/reference/runtime-agent-api) — agent lifecycle envelope
- [Component Kind Catalog](/reference/component-kind-catalog) — kind ごとの
  outputs と capabilities
- [Manifest](/manifest) — operator が apply する manifest の syntax
- [Extending](/extending) — 新 provider 追加時の `KernelPlugin` 作り方
