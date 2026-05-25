# Provider Implementations {#provider-implementations}

provider は、operator が component kind URI に対して用意する実装です。AppSpec
author は `kind` / `spec` / `publish` / `listen` を宣言し、operator はその kind
contract をどの component-kind execution / resource binding で実現するかを選び
ます。account-plane material は operator distribution が所有する external
publication として解決され、provider identity そのものではありません。provider
は TypeScript reference adapter、native controller、static registry、SaaS
adapter などの形を取れます。

Takosumi reference kernel は AppSpec を読み、component ごとに operator alias map
で `kind` を URI に解決し、operator-selected execution binding を選びます。
reference implementation では、その binding が operation envelope を
runtime-agent / connector、または operator-owned execution host に渡します。
in-process adapter code は validation / plan / envelope 生成を担えますが、
side-effecting provider I/O と cloud / OS credential は kernel process の外に置
きます。

AppSpec author は `kind`、`spec`、local `publish`、local `listen` を宣言します。
operator は execution binding inventory を持ち、各 component
の実行先を決めます。

The example assumes an operator profile maps `worker` and `object-store` short
aliases to adopted descriptor URIs.

```yaml
components:
  api:
    kind: worker
    spec:
      entrypoint: src/worker.ts
  bucket:
    kind: object-store
    spec:
      name: app-assets
      versioning: true
```

この例では operator が `worker` alias を reference worker URI へ解決し、operator
profile が採用した JS worker provider で実行します。ある profile では Cloudflare
Workers、別 profile では Deno Deploy を選べますが、1 回の resolution では kind
URI に対する implementation binding は一意です。official catalog の
`web-service` descriptor は container-style service を表す reusable descriptor
で、operator profile が採用した場合に使います。`object-store` も profile ごとに
R2、S3、GCS、MinIO、local filesystem などへ解決できます。 これらは provider inventory
の例です。実際に portable と言えるのは、operator が matching execution binding
と lifecycle credential を持ち、kind URI、material contract、operator-selected
support constraints / extension fields、provider deploy material と operator
evidence がそろった範囲です。reference provider packages では、その execution
binding を provider package / runtime-agent connector として実装します。

## 読み方 {#reading-order}

- AppSpec を書く人は [AppSpec](./app-spec.md) を先に読んでください。operator
  profile が short alias を descriptor URI に map している場合は
  [Takosumi Official Type Catalog Specification](./type-catalog.md) も参照して
  ください。`referenceAliases` は catalog 側の提案であり、alias を有効にするの
  は operator profile です。
- provider を運用する人は、このページで reference implementation の attach と
  selection を確認してください。
- reference provider package 例だけを見たい場合は
  [Provider package examples](./provider-packages.md)。
- runtime-agent 側の connector envelope は
  [Connector guide](./connector-contract.md)。

## Reference kernel で provider を attach する {#operator-attach}

An operator using the reference kernel imports the provider packages it needs
and `createPaaSApp()` に adapter factory を渡します。cloud SDK や credential は
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
non-secret 設定を受け取り、kernel が dispatch できる binding を登録します。cloud
credential は runtime-agent の connector env または operator host 側に置きます。

## Reference kernel の選択 flow {#selection-rule}

component ごとに、Takosumi reference kernel は次の順で implementation binding
を決めます。kind descriptor は component の semantic identity と input schema
を説明します。provider support / capability / native schema は provider package
または operator profile の metadata です。`KernelPlugin.provides[]` は reference
kernel の adapter matching interface です。別 implementation は同じ kind URI と
material contract を別の registry / controller / adapter で実行できます。

1. `kindAliases` で short alias を URI に解決する。URI はそのまま使う。
2. operator profile が catalog descriptor metadata を使う場合は、解決した kind
   URI の descriptor を選ぶ。Takosumi official type catalog の public
   descriptors は `/kinds/v1/*` JSON-LD。
3. catalog descriptor metadata を採用した場合は、component `spec` を descriptor
   の input schema に対して検証する。
4. Space に見える implementation binding を選ぶ。reference kernel では
   `provides[]` に kind URI を含む reference provider adapter を選ぶ。
5. provider package / operator profile metadata から support、capability、Space
   policy を確認し、operator profile 内で binding が一意であることを確認する。
6. 対応する implementation binding が無ければ、provider
   の副作用を出す前に失敗する。
7. reference adapter array (`plugins` option) bootstrap で同じ kind URI を複数
   provider が提供し、Space policy / profile でも一意に選べない場合は、provider
   selection validation が reject する。

capability は open string です。provider は任意の kebab-case 識別子を宣言し、
dashboard や operator tooling の introspection に使います。

Provider-specific metadata belongs to provider package docs or the operator
profile that enables the provider. External publication publisher roots belong
to operator distribution or product distribution specs.

## Provider id と package id {#provider-id-vs-package-id}

provider docs では **provider id** と **package id** を分けます。

| 種類        | 例                                     | 使いどころ                              |
| ----------- | -------------------------------------- | --------------------------------------- |
| provider id | `@takos/cloudflare-workers`            | retained evidence、audit、provider hint |
| package id  | `@takos/takosumi-cloudflare-providers` | operator が import する JSR package     |

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
  `KernelPlugin` へ変換する reference-kernel helper。
- `packages/plugins/spec/kinds/v1/*.jsonld` — Takosumi official type catalog
  descriptor source。
- `packages/plugins/src/kinds/` — descriptor source から生成/手書き補助される
  reference-kernel helper types と validators。core wire schema ではない。
- `packages/*-providers/src/` — cloud / self-host ごとの provider factory。
