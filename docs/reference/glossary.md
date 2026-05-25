# 用語集 {#glossary}

## AppSpec

source root の `.takosumi.yml`。→ [AppSpec](./app-spec.md)

## Component

AppSpec の `components` map entry。公開 field: `kind` / `spec` / `publish` /
`listen`。

## Kind

component の opaque type discriminator。operator distribution が short alias /
URI を kind descriptor と implementation binding に解決する。takosumi.com の例は
[Takosumi Official Type Catalog Specification](./type-catalog.md)。

## Publication / Listen

component 間接続。producer = `publish`、consumer = `listen`。

## Installation

Space に入った AppSpec。→ [Installer API](./installer-api.md)

## Deployment

1 回の apply 結果。rollback は retained Deployment を根拠に current pointer
を戻し、新 Deployment は作らない。

## Space

Installation / Deployment の isolation 境界。AppSpec には書かない。

## Source

Installer API に渡す source 種別: `git` / `prepared` / `local`。→
[Installer API](./installer-api.md)

## dry-run

apply せずに検証し、変更計画と digest guard を返す操作。2 endpoint。

## expected pin

dry-run response の reviewed-source guard。apply 時に渡すと、review した source
と異なる入力を 409 で止める。

## apply

AppSpec source を Installation に反映し、Deployment record を作る操作。

## Build service handoff

AppSpec 外で source を prepared source archive にする build / CI convention。
reference handoff は `.takosumi.build.yml` を使える。→
[Build service handoff](./build-spec.md)

## External publication

operator-owned material の Space-scoped 公開。→
[External publications](./external-publications.md)

## Kind descriptor

component kind の input schema、publication、projection capability、output
metadata を説明する operator-adopted metadata。Takosumi official type catalog は
JSON-LD で descriptor を公開する。runtime behavior は implementation binding
が持つ。

## Material contract

`publish.<name>.as` が offer する bindable output の型。例:
`http-endpoint`、`service-binding`、`object-store`。

## Projection

`listen.<binding>.as` によって material contract を consumer runtime に渡す形。
例: `env`、`secret-env`、`mount`、`upstream`。

## Implementation binding

operator が kind URI / descriptor を concrete provider runtime や resource
operation に結びつける実装側の binding。reference kernel では adapter array
(`plugins` option) がこの役割を担う。

## Retained implementation/operator evidence

Deployment に紐づけて retained ledger に残る selected descriptor /
implementation binding、publication/materialization result、operator evidence。
public Deployment wire が保証するのは source identity、manifest digest、status、
non-secret outputs です。retained evidence は後続の rollback / audit / current
projection の根拠になります。

## Current pointer

Installation が現在有効として指す retained Deployment。Installer API では
`currentDeploymentId`。rollback はこの pointer を過去の `succeeded` Deployment
へ戻す。

## Reference implementation vocabulary

ここから下は reference Takosumi kernel / operator implementation
を読むときの用語です。AppSpec authoring contract の field ではありません。

## WAL (Write-Ahead Log)

provider operation の内部 journal。→ [WAL stages](./wal-stages.md)

## OperationPlan

provider operation の実行計画。→
[Runtime Deployment Model](./architecture/runtime-deployment-model.md)

## GroupHead

traffic assignment の current pointer。→
[GroupHead rollout](./group-head-rollout.md)

## RevokeDebt

destroy / revoke 失敗時の未回収副作用の記録。→
[RevokeDebt model](./revoke-debt.md)

## ObservationSet

activate 後の runtime observation 集合。→
[Observation retention](./observation-retention.md)

## Provider implementation

具体 substrate 向け implementation binding。→
[Provider Implementations](./providers.md)

## KernelPlugin

reference kernel の provider implementation binding shape。AppSpec 仕様の語彙は
kind / spec / publish / listen に置かれ、plugin は reference Takosumi
implementation の attach mechanism として扱う。

## Connector

runtime-agent 側の provider operation 実行者。→
[Connector Guide](./connector-contract.md)

## DataAsset {#artifact}

operator optional extension の content-addressed blob。`artifact` は historical
wire / CLI compatibility name。→ [DataAsset Policy](./data-asset-policy.md)

## Prepared Source

build 後 source tree を archive payload として固定した handoff source。Installer
API は取得した payload bytes の sha256 を resolved source identity として記録す
る。

## manifestDigest

`.takosumi.yml` bytes の digest (Installer API wire field)。

## Runtime-Agent

kernel から lifecycle RPC を受け、cloud API / OS executor を呼ぶ lifecycle
execution host。→ [runtime-agent 分離](../operator/runtime-agent.md) /
[Reference Runtime-Agent Execution Surface](./runtime-agent-api.md)

## fail-closed

不明入力 / 未解決 dependency を副作用前に明示的に拒否する方針。

## Operator

kernel を起動し、provider / credential / storage / account-plane
連携を選ぶ主体。→ [Operator](../operator/)

## Account-Plane

account / billing / OIDC issuer / customer onboarding を所有する operator 側の
plane。
