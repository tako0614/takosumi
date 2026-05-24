# Provider Implementations {#provider-implementations}

> このページでわかること: AppSpec の component を、どの runtime / cloud / local
> backend に materialize するかを operator implementation がどう決めるか。

Takosumi reference kernel は AppSpec を読み、component ごとに operator alias map
で `kind` を URI に解決し、operator が渡した implementation binding を選びます。
その binding は operation envelope を runtime-agent / connector、または
operator-owned execution host に渡します。in-process adapter code は validation
/ plan / envelope 生成を担えますが、side-effecting provider I/O と cloud / OS
credential は kernel process の外に置きます。

AppSpec author は `kind`、`spec`、local `publish`、local `listen` を宣言します。
operator は implementation binding array を持ち、各 component の実行先を決めま
す。

```yaml
components:
  api:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
  bucket:
    kind: object-store
    spec:
      name: app-assets
      versioning: true
```

この例では operator が `worker` alias を reference worker URI へ解決し、選択した
JS worker provider で実行します。reference distribution では Cloudflare Workers
や Deno Deploy を選べます。container runtime は `web-service` kind を使います。
`object-store` も R2、S3、GCS、MinIO、local filesystem などへ解決できます。

## 読み方 {#reading-order}

- AppSpec を書く人は [AppSpec](./app-spec.md) と
  [Reference Kind Descriptors](./kind-registry.md) を先に読んでください。
- provider を運用する人は、このページで reference implementation の attach と
  selection を確認してください。
- reference provider package 例だけを見たい場合は
  [Provider package examples](./provider-packages.md) を参照してください。
- runtime-agent 側の connector envelope は
  [Connector guide](./connector-contract.md) を参照してください。

## Reference kernel で provider を attach する {#operator-attach}

Takosumi reference operator は必要な provider package を import し、
`createPaaSApp()` に adapter factory を渡します。cloud SDK や credential は
runtime-agent / connector / operator host 側に置きます。

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
します。 `KernelPlugin` は reference kernel の implementation binding shape
です。factory は region / account id / lifecycle client など operator-owned の
non-secret 設定 を受け取り、kernel が dispatch できる binding
を登録します。cloud credential は runtime-agent の connector env または operator
host 側に置きます。

## 選択ルール {#selection-rule}

component ごとに、operator distribution は次の順で implementation binding
を決めます。 Takosumi reference kernel では implementation binding が reference
provider adapter です。

1. `kindAliases` で short alias を URI に解決する。URI はそのまま使う。
2. operator distribution が descriptor metadata を使う場合は、解決した kind URI
   の descriptor を選ぶ。takosumi.com reference descriptors は JSON-LD。
3. component `spec` を descriptor の input schema に対して検証する。
4. Space に見える implementation binding を選ぶ。reference kernel では
   `provides[]` に kind URI を含む reference provider adapter を選ぶ。
5. provider support、capability、Space policy を確認する。
6. 対応する implementation binding が無ければ、provider
   の副作用を出す前に失敗する。
7. 同じ kind URI を複数 provider が提供する bootstrap は provider selection
   validation が reject する。

capability は open string です。provider は任意の kebab-case 識別子を宣言し、
dashboard や operator tooling の introspection に使います。

provider capability / descriptor metadata の予約 prefix は次の通りです。これは
public AppSpec `namespace:<path>` の prefix 一覧ではありません。product-specific
prefix は、その product / operator profile の docs で定義します。

| Prefix       | Owner                                       |
| ------------ | ------------------------------------------- |
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

## Operator / account-plane responsibilities {#operator-account-plane-responsibilities}

Provider implementation は operator distribution の runtime binding です。
operator distribution と account-plane は次の責務を扱います。

- cloud account の作成や課金判断
- provider credential の発行・保管
- operator UI や customer onboarding
- marketplace から provider 実装を取得する仕組み
- user account / OIDC issuer / billing system

reference kernel は、operator が起動時に渡した implementation binding array を
使って AppSpec の component を materialize します。

## 実装上の source root {#source-roots}

実装を追う場合の入口は次です。

- `packages/contract/src/plugin.ts` — reference kernel の `KernelPlugin` adapter
  API。
- `packages/contract/src/provider-plugin.ts` — provider adapter から
  `KernelPlugin` へつなぐ bridge。
- `packages/plugins/src/kinds/` — takosumi.com reference kind schema と output
  convention。
- `packages/*-providers/src/` — cloud / self-host ごとの provider factory。
