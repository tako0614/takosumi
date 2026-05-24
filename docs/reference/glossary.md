# 用語集 {#glossary}

Takosumi kernel docs で使う主要語彙です。将来 RFC や過去 Wave の履歴は
[RFC](../rfc/0001-kernel-kind-agnostic.md) 側に置き、本ページは current docs を
読むための短い定義に絞ります。

## AppSpec

source root の `.takosumi.yml`。root は `apiVersion`、`metadata`、 `components`
の 3 field です。詳細は [AppSpec](./app-spec.md)。

## Build service handoff

source root の optional `.takosumi.build.yml`。operator build service、CI、また
は operator automation が source tree を準備し、prepared source snapshot を作る
ための handoff convention です。

詳細は [Build service handoff](./build-spec.md)。

## Installation

Space に入った AppSpec。apply / rollback の対象になる current state 単位です。
作成は [Installer API](./installer-api.md) の `POST /v1/installations`
で行います。

## Space

Installation と Deployment が属する isolation / ownership 境界です。AppSpec は
Space を宣言せず、Installer API request や token claim が対象 Space を決めます。

## Deployment

1 回の apply / rollback の結果。成功・失敗を問わず audit と rollback の根拠と
して record されます。

## apply

AppSpec source を Installation に反映し、新しい Deployment record を作る操作
です。新規 install の最初の apply も、既存 Installation への deploy も
Deployment history に残ります。

## expected pin

dry-run response が返す source / AppSpec digest guard です。apply 時に同じ値を
渡すと、dry-run 後に source や `.takosumi.yml` が変わっていた場合に
`409 failed_precondition` で止まります。

## Component

AppSpec の `components` map の entry。公開 field は `kind`、`spec`、`publish`、
`listen` です。component name は map key です。

## Kind

component の opaque type discriminator。`worker`、`postgres`、`object-store`、
`gateway` などは takosumi.com が公開する reference kind descriptor examples の
alias 例です。詳細は [Kind Descriptor Examples](./kind-registry.md)。

## Publication / Listen

component 間接続の model です。producer は `publish.<name>` で local publication
を定義し、consumer は `listen.<name>.from` で `component.publication` または
`namespace:<path>` を受け取ります。

## Namespace export

AppSpec component の外にある operator-owned material を Space-scoped に公開する
model です。例として `operator.identity.oidc` があります。詳細は
[Namespace exports](./namespace-exports.md)。

## Reference implementation vocabulary

ここから下は Takosumi reference kernel / operator distribution を読むための語彙
です。AppSpec / Installation / Deployment の public model を理解するだけなら、
必要になってから読めば十分です。

## Materializer

kind と `spec` を具体 runtime / resource に変換する operator implementation の
一般名です。current docs では provider implementation / implementation binding
と同じ領域を指します。

## Provider implementation

Cloudflare / AWS / GCP / Kubernetes / self-host など、具体 substrate 向けの
materializer 実装です。詳細は [Provider Implementations](./providers.md)。

## KernelPlugin

Takosumi reference kernel が使う provider implementation binding shape です。
`provides[]`、capability、apply / destroy、optional lifecycle hook を持ちます。
これは reference implementation の配線方法であり、Takosumi spec の必須 plugin
mechanism ではありません。

## Connector

runtime-agent 側で provider operation を実行する implementation です。kernel は
selected implementation binding を通じて operation envelope を dispatch し、
connector は cloud API や OS executor を操作します。Takosumi reference kernel
ではこの binding を `KernelPlugin` で表します。詳細は
[Connector Guide](./connector-contract.md)。

## Artifact

route / CLI 名に残る historical term です。概念名は DataAsset です。DataAsset は
operator extension が扱う content-addressed blob を指します。保存・取得・GC の
詳細は [DataAsset Policy](./data-asset-policy.md) と
[DataAsset GC](./artifact-gc.md)。

## DataAsset

operator が optional extension として扱う content-addressed blob です。build 後
source は DataAsset ではなく prepared source snapshot として Installer API
に渡します。

## Prepared Source

build / prepare 後の source tree を tar + sha256 で固定した snapshot です。
Installer API では `source.kind: "prepared"` として渡します。

## manifestDigest

Installer API に残っている wire field name です。current docs では
`.takosumi.yml` file bytes の byte-stream digest を指します。

## Runtime-Agent

kernel から lifecycle RPC を受け取り、cloud API や OS executor を呼ぶ data plane
process です。運用手順は [runtime-agent 分離](../operator/runtime-agent.md)、
wire contract は [Runtime-Agent API](./runtime-agent-api.md)。

## fail-closed

不明な入力や未解決 dependency を黙って fallback せず、provider operation などの
副作用を出す前に明示的に失敗することです。

## Operator

Takosumi kernel を起動し、provider
implementation、credential、runtime-agent、storage、 account-plane
連携を選ぶ主体です。operator 向け導線は [Operator](../operator/)。

## Account-Plane

account、billing、OIDC issuer、customer onboarding、managed offering UI を所有
する operator 側の plane です。Takosumi kernel docs では詳細を扱いません。
