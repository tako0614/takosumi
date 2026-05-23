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

kernel の public entity ではありません。詳細は [BuildSpec](./build-spec.md)。

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

component の opaque type discriminator。Takosumi spec は公式 component kind を
定義しません。`worker`、`postgres`、`object-store`、`custom-domain` などは Takos
reference registry の alias 例です。詳細は
[Reference Kind Registry](./kind-catalog.md)。

## Materializer

kind と `spec` を具体 runtime / resource に変換する apply 実装です。operator は
provider package の `KernelPlugin` factory か inline materializer を attach し
ます。

## Provider plugin

Cloudflare / AWS / GCP / Kubernetes / self-host など、具体 substrate 向けの
materializer 実装です。詳細は [Provider plugin](./providers.md)。

## KernelPlugin

provider plugin が返す contract shape です。`provides[]`、capability、apply /
destroy、optional lifecycle hook を持ちます。

## Namespace pub/sub

component 間接続の model です。producer は `publish` で namespace path に
material を登録し、consumer は `listen` で受け取ります。旧 `use:` edge や
`${ref:...}` interpolation は使いません。

## Namespace export

AppSpec component の外にある operator-owned material を Space-scoped に公開する
model です。例として `operator.identity.oidc` があります。詳細は
[Namespace exports](./namespace-exports.md)。

## Connector

runtime-agent 側で provider operation を実行する adapter です。kernel は
`KernelPlugin` contract を通じて provider lifecycle を呼び、connector は cloud
API や OS executor を操作します。詳細は
[Connector Contract](./connector-contract.md)。

## Artifact

uploaded blob の digest-pinned data asset です。artifact route は 保存・取得・GC
を扱い、workflow runner 自体にはなりません。AppSpec の component kind contract
ではありません。詳細は [DataAsset Policy](./data-asset-policy.md) と
[Artifact GC](./artifact-gc.md)。

## Prepared Source

build / prepare 後の source tree を tar + sha256 で固定した snapshot です。
Installer API では `source.kind: "prepared"` として渡します。

## manifestDigest

Installer API に残っている wire field name です。current docs では AppSpec
digest を指します。

歴史的な `manifest` 語を public concept として増やすものではありません。

## Runtime-Agent

kernel から lifecycle RPC を受け取り、cloud API や OS executor を呼ぶ data plane
process です。運用手順は [runtime-agent 分離](../operator/runtime-agent.md)、
wire contract は [Runtime-Agent API](./runtime-agent-api.md)。

## fail-closed

不明な入力や未解決 dependency を黙って fallback せず、provider operation などの
副作用を出す前に明示的に失敗することです。

## Operator

Takosumi kernel を起動し、provider plugin、credential、runtime-agent、storage、
account-plane 連携を選ぶ主体です。operator 向け導線は [Operator](../operator/)。

## Account-Plane

account、billing、OIDC issuer、customer onboarding、managed offering UI を所有
する operator 側の plane です。Takosumi kernel docs では詳細を扱いません。
