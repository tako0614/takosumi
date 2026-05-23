# Provider Implementations {#provider-plugins}

> このページでわかること: AppSpec の component を、どの runtime / cloud / local
> backend に materialize するかを operator implementation がどう決めるか。

Takosumi kernel は AppSpec を読み、component ごとに operator alias map で `kind`
を URI に解決し、対応する provider lifecycle を呼びます。Takosumi reference
kernel では **reference provider adapter** がその lifecycle を kernel に渡す
adapter です。

AppSpec author は `kind`、`spec`、`publish`、`listen` を宣言します。operator は
provider implementation set を持ち、各 component の実行先を決めます。

```yaml
components:
  api:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
      compatibilityDate: "2025-01-01"
  bucket:
    kind: object-store
    spec:
      name: app-assets
      versioning: true
```

この例では operator が `worker` alias を reference worker URI へ解決し、
Cloudflare Workers や Deno Deploy の JS worker provider で実行します。container
runtime は `web-service` kind を使います。`object-store` も R2、S3、GCS、MinIO、
local filesystem などへ解決できます。

## 読み方 {#reading-order}

- AppSpec を書く人は [AppSpec](./app-spec.md) と
  [Reference Kind Descriptors](./kind-registry.md) を先に読んでください。
- provider を運用する人は、このページで reference implementation の attach と
  selection を確認してください。
- reference provider package 例だけを見たい場合は
  [Provider package examples](./provider-packages.md) を参照してください。
- runtime-agent 側の connector envelope は
  [Connector contract](./connector-contract.md) を参照してください。

## Reference kernel で provider を attach する {#operator-attach}

Takosumi reference operator は必要な provider package を import し、
`createPaaSApp()` に渡します。cloud SDK や credential は provider package /
runtime-agent / operator host 側に置きます。

```ts
import { createPaaSApp } from "@takos/takosumi-kernel/bootstrap";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import { awsS3ObjectStoreProvider } from "@takos/takosumi-aws-providers";
import { cloudflareWorkerProvider } from "@takos/takosumi-cloudflare-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    cloudflareWorkerProvider({ accountId }),
    awsS3ObjectStoreProvider({ region }),
  ],
});
```

各 reference provider package は `KernelPlugin` を返す factory を export
します。factory は region / account id / lifecycle client など operator-owned の
non-secret 設定を受け取り、kernel が呼べる apply / destroy / status lifecycle
を登録します。cloud credential は runtime-agent の connector env または operator
host 側に置きます。

## 選択ルール {#selection-rule}

component ごとに、reference kernel は次の順で provider lifecycle を決めます。

1. `kindAliases` で short alias を URI に解決する。URI はそのまま使う。
2. component `kind` URI を `provides[]` に含む reference provider adapter を 1
   つ探す。
3. adapter が見つかれば provider lifecycle を実行する。
4. 対応する implementation binding が無ければ、provider
   の副作用を出す前に失敗する。
5. 同じ kind URI を複数 provider が提供する bootstrap は provider selection
   validation が reject する。

capability は open string です。provider は任意の kebab-case 識別子を宣言し、
dashboard や operator tooling の introspection に使います。

予約 prefix は次の 3 つです。

| Prefix       | Owner                                       |
| ------------ | ------------------------------------------- |
| `takos.*`    | Takos など consumer application 側の語彙    |
| `system.*`   | Takosumi kernel / runtime-agent 側の語彙    |
| `operator.*` | operator が自分の deployment で定義する語彙 |

bare identifier は一般 capability として provider が宣言できます。新しい予約
prefix は RFC を通して追加します。

## Provider id と package id {#provider-id-vs-package-id}

provider docs では **provider id** と **package id** を分けます。

| 種類        | 例                                     | 使いどころ                                |
| ----------- | -------------------------------------- | ----------------------------------------- |
| provider id | `@takos/cloudflare-workers`            | Deployment evidence、audit、provider hint |
| package id  | `@takos/takosumi-cloudflare-providers` | operator が import する JSR package       |

1 つの package が複数 provider id を export する場合があります。たとえば AWS
package は S3、Fargate、RDS、Route53 向けの provider factory
をまとめて提供します。

## Operator / account-plane responsibilities {#not-owned-by-kernel}

Provider implementation は operator distribution の runtime binding です。
operator distribution と account-plane は次の責務を扱います。

- cloud account の作成や課金判断
- provider credential の発行・保管
- operator UI や customer onboarding
- marketplace から provider 実装を取得する仕組み
- user account / OIDC issuer / billing system

reference kernel は、operator が起動時に渡した provider set を使って AppSpec の
component を materialize します。

## 実装上の source root {#source-roots}

実装を追う場合の入口は次です。

- `packages/contract/src/provider-plugin.ts` — reference kernel の
  `KernelPlugin` adapter shape。
- `packages/plugins/src/kinds/` — takosumi.com reference kind schema と output
  convention。
- `packages/*-providers/src/` — cloud / self-host ごとの provider factory。
