# Operator Bootstrap

> このページでわかること: kernel に bundled provider plugin
> を接続する初期設定の手順。

`createTakosumiProductionProviders(opts)` で **21 個の bundled provider plugin
(default-on 20 + opt-in 1)** を kernel に wire する。

source:
[`packages/plugins/src/shape-providers/factories.ts`](https://github.com/takos-jp/takosumi/blob/main/packages/plugins/src/shape-providers/factories.ts)

credential / SDK boundary は
[Concepts § Architecture](/getting-started/concepts#architecture-kernel--runtime-agent)
参照。 factory 経由で wire された provider は runtime-agent に lifecycle
envelope (apply / destroy / describe) を POST するだけ。

## API シグネチャ

```ts
import { registerProvider } from "takosumi-contract";
import { createTakosumiProductionProviders } from "@takos/takosumi-plugins/shape-providers/factories";

const providers = createTakosumiProductionProviders({
  agentUrl: "http://127.0.0.1:8789",
  token: Deno.env.get("TAKOSUMI_AGENT_TOKEN")!,
  artifactStore: {
    baseUrl: "https://kernel.example.com/v1/artifacts",
    token: Deno.env.get("TAKOSUMI_ARTIFACT_FETCH_TOKEN"),
  },
  enableDenoDeploy: false,
});

for (const provider of providers) {
  registerProvider(provider);
}
```

`agentUrl` と `token` が必須。 AWS / GCP / Cloudflare / Azure / Kubernetes /
Selfhost は既定で有効。 Deno Deploy は `enableDenoDeploy: true` で追加される。
stock boot (`takosumi server` / `packages/kernel/src/index.ts`) では
`TAKOSUMI_ENABLE_DENO_DEPLOY_PROVIDER=1` がこの opt-in に対応する。

## `TakosumiProductionProviderOptions`

```ts
interface TakosumiProductionProviderOptions {
  readonly agentUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly enableAws?: boolean; // default true
  readonly enableGcp?: boolean; // default true
  readonly enableCloudflare?: boolean; // default true
  readonly enableAzure?: boolean; // default true
  readonly enableKubernetes?: boolean; // default true
  readonly enableSelfhost?: boolean; // default true
  readonly enableDenoDeploy?: boolean; // default false
  readonly artifactStore?: ArtifactStoreLocator;
}
```

`enable*` は provider registry の公開範囲を絞る switch。 runtime-agent 側に該当
connector がない cloud は無効化する。

## Provider 数

| group       | default | opt-in | provider ids                                                                                                                                                              |
| ----------- | ------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AWS         | 4       | 0      | `@takos/aws-s3`, `@takos/aws-fargate`, `@takos/aws-rds`, `@takos/aws-route53`                                                                                             |
| GCP         | 4       | 0      | `@takos/gcp-gcs`, `@takos/gcp-cloud-run`, `@takos/gcp-cloud-sql`, `@takos/gcp-cloud-dns`                                                                                  |
| Cloudflare  | 4       | 0      | `@takos/cloudflare-r2`, `@takos/cloudflare-container`, `@takos/cloudflare-workers`, `@takos/cloudflare-dns`                                                               |
| Azure       | 1       | 0      | `@takos/azure-container-apps`                                                                                                                                             |
| Kubernetes  | 1       | 0      | `@takos/kubernetes-deployment`                                                                                                                                            |
| Selfhost    | 6       | 0      | `@takos/selfhost-filesystem`, `@takos/selfhost-minio`, `@takos/selfhost-docker-compose`, `@takos/selfhost-systemd`, `@takos/selfhost-postgres`, `@takos/selfhost-coredns` |
| Deno Deploy | 0       | 1      | `@takos/deno-deploy`                                                                                                                                                      |

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
const providers = createTakosumiProductionProviders({
  agentUrl: "http://127.0.0.1:8789",
  token: Deno.env.get("TAKOSUMI_AGENT_TOKEN")!,
  enableAws: false,
  enableGcp: false,
  enableCloudflare: false,
  enableAzure: false,
  enableKubernetes: false,
});
// providers = @takos/selfhost-* の 6 provider
```

この構成と相性が良い template が
[`selfhosted-single-vm@v1`](/reference/templates#selfhosted-single-vm-v1)。

## 関連ページ

- [Provider Plugins](/reference/providers) — 20 default + 1 opt-in provider
  の実装と capabilities
- [Runtime-agent API](/reference/runtime-agent-api) — agent lifecycle envelope
- [Shape Catalog](/reference/shapes) — Shape ごとの outputs と capabilities
- [Manifest](/manifest) — operator が apply する manifest の syntax
- [Extending](/extending) — 新 provider 追加時の factory 配線
