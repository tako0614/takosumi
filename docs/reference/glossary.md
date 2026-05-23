# 用語集 {#glossary}

Takosumi kernel docs で使う主要語彙です。将来 RFC や過去 Wave の履歴は
[RFC](../rfc/0001-kernel-kind-agnostic.md) 側に置き、本ページは current docs を
読むための短い定義に絞ります。

## AppSpec

source root の `.takosumi.yml`。root は `apiVersion`、`metadata`、 `components`
の 3 field です。詳細は [AppSpec](./app-spec.md)。

## BuildSpec

source root の optional `.takosumi.build.yml`。

build service が source tree を準備し、prepared source snapshot を作るための入力
です。

詳細は [BuildSpec](./build-spec.md)。

## Installation

Space に入った AppSpec。apply / rollback の対象になる current state 単位です。
作成は [Installer API](./installer-api.md) の `POST /v1/installations`
で行います。

## Deployment

1 回の apply / rollback の結果。成功・失敗を問わず audit と rollback の根拠と
して record されます。

## Component

AppSpec の `components` map の entry。公開 field は `kind`、`spec`、`publish`、
`listen` です。component name は map key です。

## Kind

component の opaque type discriminator。`worker`、`postgres`、`object-store`、
`custom-domain` などは takosumi.com reference descriptor examples の alias
例です。詳細は [Reference Kind Descriptors](./kind-registry.md)。

## Materializer

kind と `spec` を具体 runtime / resource に変換する apply 実装です。Takosumi
reference kernel では provider package の `KernelPlugin` factory を attach
します。

## Provider implementation

Cloudflare / AWS / GCP / Kubernetes / self-host など、具体 substrate 向けの
materializer 実装です。詳細は [Provider Implementations](./providers.md)。

## KernelPlugin

Takosumi reference kernel が使う provider implementation adapter shape です。
`provides[]`、capability、apply / destroy、optional lifecycle hook を持ちます。

## Namespace pub/sub

component 間接続の model です。producer は `publish` で namespace path に
material を登録し、consumer は `listen` で受け取ります。

## Namespace export

AppSpec component の外にある operator-owned material を Space-scoped に公開する
model です。例として `operator.identity.oidc` があります。詳細は
[Namespace exports](./namespace-exports.md)。

## Connector

runtime-agent 側で provider operation を実行する adapter です。kernel は
selected implementation binding を通じて provider lifecycle を呼び、connector は
cloud API や OS executor を操作します。Takosumi reference kernel ではこの
binding を `KernelPlugin` で表します。詳細は
[Connector Contract](./connector-contract.md)。

## Artifact

route / CLI 名に残る historical term です。canonical concept は DataAsset
で、operator DataAsset extension が扱う content-addressed blob を指します。
artifact route は保存・取得・GC を扱います。詳細は
[DataAsset Policy](./data-asset-policy.md) と [DataAsset GC](./artifact-gc.md)。

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
