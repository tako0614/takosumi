# Operator Bootstrap

> このページでわかること: kernel に bundled provider plugin
> を接続する初期設定の手順。

operator が **21 個の bundled provider plugin (default-on 20 + opt-in 1)** を
kernel に wire するための factory `createTakosumiProductionProviders(opts)`
の使い方をまとめます。

source:
[`packages/plugins/src/shape-providers/factories.ts`](https://github.com/takos-jp/takosumi/blob/main/packages/plugins/src/shape-providers/factories.ts)

> 重要: factory 経由で wire された provider は runtime-agent に lifecycle
> envelope (apply / destroy / describe) を POST します。credential と SDK code
> は runtime-agent 側に置き、kernel process には置きません
> ([Provider Plugins § Real client](/reference/providers#real-client--lifecycle-adapter))。

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

`agentUrl` と `token` が必須です。AWS / GCP / Cloudflare / Azure / Kubernetes /
Selfhost は既定で有効、Deno Deploy だけは `enableDenoDeploy: true`
を渡したときに追加されます。 stock boot (`takosumi server` /
`packages/kernel/src/index.ts`) では `TAKOSUMI_ENABLE_DENO_DEPLOY_PROVIDER=1`
がこの opt-in に対応します。

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

`enable*` は provider registry 側の公開範囲を絞るための switch です。
runtime-agent 側に該当 connector がない cloud は無効化してください。

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

provider id は manifest に書く安定した id です。runtime-agent の connector 名は
実装詳細で、operator は agent boot 時に必要な connector credential / local path
を設定します。

例:

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
[`selfhosted-single-vm@v1`](/reference/templates#selfhosted-single-vm-v1) です。

## 関連ページ

- [Provider Plugins](/reference/providers) — 20 default + 1 opt-in provider の
  実装と capabilities
- [Runtime-agent API](/reference/runtime-agent-api) — agent lifecycle envelope
- [Shape Catalog](/reference/shapes) — Shape ごとの outputs と capabilities
- [Manifest](/manifest) — operator が apply する manifest の syntax
- [Extending](/extending) — 新 provider 追加時の factory 配線
