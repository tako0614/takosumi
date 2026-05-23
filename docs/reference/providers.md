# Provider plugin {#provider-plugins}

> このページでわかること: AppSpec の component を、どの runtime / cloud / local
> backend に materialize するかを provider plugin がどう決めるか。

Takosumi kernel は AppSpec を読み、component ごとに operator alias map で `kind`
を URI に解決し、対応する materializer を呼びます。 **provider plugin** は、その
materializer を operator が kernel に渡すための package です。

AppSpec author から見ると、provider plugin は通常は意識しません。AppSpec は
`kind`、`spec`、`publish`、`listen` を宣言し、どの provider を使えるかは
operator が起動時に決めます。

```yaml
components:
  api:
    kind: worker
    spec:
      artifact:
        kind: js-bundle
        hash: sha256:...
      compatibilityDate: "2025-01-01"
  bucket:
    kind: object-store
    spec:
      name: app-assets
      versioning: true
```

この例の `worker` は Takosumi spec の contract-owned kind
ではありません。operator が `worker` alias を reference worker URI
へ解決する設定を持つ場合に、 Cloudflare Workers や Deno Deploy の JS worker
provider で実行できます。container runtime は別 kind の `web-service`
を使います。`object-store` も R2、S3、GCS、MinIO、 local filesystem などへ
解決できます。

## 読み方 {#reading-order}

- AppSpec を書く人は [AppSpec](./app-spec.md) と
  [Reference Kind Registry](./kind-catalog.md) を先に読んでください。
- provider を運用する人は、このページで attach と selection を確認してください。
- 同梱 provider の一覧だけを見たい場合は
  [Provider catalog](./provider-catalog.md) を参照してください。
- runtime-agent 側の connector envelope は
  [Connector contract](./connector-contract.md) を参照してください。

## Operator が provider を attach する {#operator-attach}

operator は必要な provider package を import し、`createPaaSApp()` に渡します。
kernel core は cloud SDK や credential を直接所有しません。

```ts
import { createPaaSApp } from "@takos/takosumi-kernel";
import { TAKOSUMI_REFERENCE_KIND_ALIASES } from "@takos/takosumi-plugins/kinds";
import { awsS3ObjectStoreProvider } from "@takos/takosumi-aws-providers";
import { cloudflareWorkerProvider } from "@takos/takosumi-cloudflare-providers";

const { app } = await createPaaSApp({
  kindAliases: TAKOSUMI_REFERENCE_KIND_ALIASES,
  plugins: [
    cloudflareWorkerProvider({ accountId, apiToken }),
    awsS3ObjectStoreProvider({ region, accessKeyId, secretAccessKey }),
  ],
});
```

各 provider package は `KernelPlugin` を返す factory を export します。factory
は credential や region など operator-owned の設定を受け取り、kernel が呼べる
apply / destroy / status lifecycle を登録します。

## 選択ルール {#selection-rule}

component ごとに、kernel は次の順で materializer を決めます。

1. `kindAliases` で short alias を URI に解決する。URI はそのまま使う。
2. component `kind` URI を `provides[]` に含む plugin を 1 つ探す。
3. plugin が見つかれば materializer lifecycle を実行する。
4. plugin が 0 件なら、provider の副作用を出す前に失敗する。
5. 同じ kind URI を複数 provider が提供する bootstrap は registry が reject
   する。

capability は open string です。provider は任意の kebab-case 識別子を宣言でき、
kernel は解釈しません。dashboard や operator tooling の introspection
に使います。

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

## Kernel が持たないもの {#not-owned-by-kernel}

provider plugin は kernel の extension point ですが、次の責務は kernel contract
ではありません。

- cloud account の作成や課金判断
- provider credential の発行・保管
- operator UI や customer onboarding
- marketplace から provider 実装を取得する仕組み
- user account / OIDC issuer / billing system

kernel が扱うのは、operator が起動時に渡した provider set を使って AppSpec の
component を materialize することだけです。

## 実装上の source root {#source-roots}

実装を追う場合の入口は次です。

- `packages/contract/src/provider-plugin.ts` — `KernelPlugin` contract。
- `packages/plugins/src/kinds/` — Takos reference kind schema と output
  convention。
- `packages/*-providers/src/` — cloud / self-host ごとの provider factory。
