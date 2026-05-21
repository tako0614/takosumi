# 用語集 {#glossary}

Takosumi kernel docs で使う主要語彙です。将来 RFC や過去 Wave の履歴は
[RFC](../rfc/0001-kernel-kind-agnostic.md) 側に置き、本ページは current docs を
読むための短い定義に絞ります。

## AppSpec

source root の `.takosumi.yml`。root は `apiVersion`、`metadata`、
`components` の 3 field です。詳細は [AppSpec](./app-spec.md)。

## Installation

Space に入った AppSpec。apply / rollback の対象になる current state 単位です。
作成は [Installer API](./installer-api.md) の `POST /v1/installations` で行います。

## Deployment

1 回の apply / rollback の結果。成功・失敗を問わず audit と rollback の根拠と
して record されます。

## Component

AppSpec の `components` map の entry。公開 field は `kind`、`spec`、`publish`、
`listen`、`build` です。component name は map key です。

## Kind

component の type discriminator。`worker`、`postgres`、`object-store`、
`custom-domain` などの kind は、それぞれ `spec` と outputs の convention を持ち
ます。詳細は [Kind Catalog](./kind-catalog.md)。

## Materializer

kind と `spec` を具体 runtime / resource に変換する apply 実装です。operator は
provider package の `KernelPlugin` factory か inline materializer を attach し
ます。

## Provider plugin

Cloudflare / AWS / GCP / Kubernetes / self-host など、具体 substrate 向けの
materializer 実装です。詳細は [Provider Plugins](./providers.md)。

## KernelPlugin

provider plugin が返す contract shape です。`provides[]`、capability、apply /
destroy、optional lifecycle hook を持ちます。

## Namespace pub/sub

component 間接続の model です。producer は `publish` で namespace path に
material を登録し、consumer は `listen` で受け取ります。旧 `use:` edge や
`${ref:...}` interpolation は使いません。

## Artifact

build output や uploaded blob の digest-pinned data asset です。artifact route は
保存・取得・GC を扱い、workflow runner 自体にはなりません。詳細は
[DataAsset Policy](./data-asset-policy.md) と [Artifact GC](./artifact-gc.md)。

## Runtime-Agent

kernel から lifecycle RPC を受け取り、cloud API や OS executor を呼ぶ data plane
process です。詳細は [Runtime-Agent API](./runtime-agent-api.md)。

## Operator

Takosumi kernel を起動し、provider plugin、credential、runtime-agent、storage、
account-plane 連携を選ぶ主体です。operator 向け導線は [Operator](../operator/)。

## Account-Plane

account、billing、OIDC issuer、customer onboarding、managed offering UI を所有
する operator 側の plane です。Takosumi kernel docs では詳細を扱いません。
