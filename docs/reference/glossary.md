# 用語集 {#glossary}

---

## Public Concepts

### Manifest

`.takosumi.yml` に書く宣言ファイル (コード上の型名: `AppSpec`)。→
[manifest](./manifest.md)

### Component

manifest 内の実行単位。公開 field は `kind` / `spec` / `connect` / `listen`。

### Kind

AppSpec の selector 語。component の `kind` は何を作るかを選び、
`publish.kind` / `listen.kind` はどの material kind を offer / consume するかを
選ぶ。operator が省略名 / URI を kind の定義と binding に解決する。manifest
field としての `type` は使わない。takosumi.com の例は
[公式カタログ仕様](./catalog.md)。

### Installation

Space に入った manifest の記録。current Deployment pointer を持つ。→
[Installer API](./installer-api.md)

### Deployment

1 回の apply 結果。履歴・audit・rollback に使う。rollback は current pointer
を過去の Deployment に戻す操作であり、新 Deployment は作らない。

### Space

Installation を収容する isolation 単位。manifest には書かない。

### Source

manifest を含むソースツリー。Installer API に渡す source 種別: `git` /
`prepared` / `local`。→ [Installer API](./installer-api.md)

### apply

dry-run 後に実行する Installation の更新操作。manifest source を Installation
に反映し、Deployment record を作る。

### expected guard

レビュー済み source が apply 時に変わっていないことを検証する TOCTOU ガード。
dry-run response の reviewed-source guard として返される。apply 時に渡すと、
review した source と異なる入力を 409 で止める。deploy expected guard は
`currentDeploymentId` も持ち、review 後に current pointer が変わった場合も 409
で止める。

### connect / listen / publish

component の接続語彙。`connect` は同じ manifest 内の component output を consume
し、`listen` は platform service path または material kind discovery で manifest
外の publication を consume する。root `publish` は component output を
Installation output publication として記録する。

### dry-run

apply せずに検証し、変更計画と digest guard を返す操作。2 endpoint。

### expected pin

expected guard の別名。→ expected guard を参照。

### Build service handoff

manifest 外で source を prepared source archive にする build / CI convention。
build-service profile は `.takosumi.build.yml`、別 filename、hosted CI、または
recipe file なしの workflow を選べる。Takosumi core は prepared source input
だけを受け取る。→ [Build service handoff](./build-spec.md)

### Current pointer

Installation が現在有効として指す retained Deployment。Installer API では
`currentDeploymentId`。rollback はこの pointer を過去の `succeeded` Deployment
へ戻す。

### Prepared source

build 後 source tree を archive payload として固定した handoff source。Installer
API は取得した payload bytes の sha256 を resolved source identity
として記録する。

### manifestDigest

`.takosumi.yml` bytes の digest (Installer API wire field)。

### fail-closed

不明入力 / 未解決 dependency を副作用前に明示的に拒否する方針。

### Operator

Takosumi を起動し、provider / credential / storage / account layer
連携を選ぶ主体。→ [Operator](../operator/)

---

## Catalog & Binding

### Material kind（出力 kind）

component output slot や platform service が提供する出力データの kind。例:
`http-endpoint`、`service-binding`、`object-store`、`mcp-server@v1`。manifest では
`publish.kind` / `listen.kind` に現れる。

### Injection mode（注入モード）

`connect.<binding>.inject` または `listen.<binding>.inject`
で指定する、出力データを consumer runtime に渡す方法 (旧: projection
family)。例: `env`、`secret-env`、`config-mount`、`upstream`。 `mount` は
`config-mount` のような path-based な注入が使う kind/operator-owned mount path
option である。

### Binding

operator が kind URI / kind の定義を concrete backend runtime や resource
operation に結びつける実装側の binding。どの仕組みで binding を読み込むかは
operator distribution が選ぶ。

### Kind schema（kind の定義）

operator が採用する metadata で、component kind の input schema、output
slot、注入 capability、output metadata を説明する。 Takosumi 公式カタログは
JSON-LD で定義を公開する。runtime behavior は binding が持つ。 ※
ドキュメント内では「kind の定義」とも表記する。

### Takosumi 公式カタログ

Takosumi が公開する再利用可能な kind の定義と material kind の
catalog。`https://takosumi.com/kinds/v1/*` で JSON-LD の定義を公開する。operator
は opt-in で Space に公開し、operator-adopted catalog も同じ core contract
で扱える。

### Platform service（プラットフォームサービス）

operator や他の Installation が Space に公開する service material。確定した対象は
`listen.path`、MCP server のように複数存在してよい対象は `listen.kind` と
optional labels / `many: true` で consume する。→
[プラットフォームサービス](./platform-services.md)

### PlatformServiceDeclaration

プラットフォームサービスの Space-scoped 宣言レコード (コード:
`PlatformServiceDeclaration`)。operator が Space
に公開するサービスの宣言を記述する。

### Deployment record（Deployment の記録）

Deployment に紐づけて ledger に残る選択された kind の定義 / binding、output
material / 実体化の結果、operator の記録。public Deployment wire が保証するのは
source identity、manifest digest、status、non-secret outputs である。Deployment
の記録は後続の rollback / audit / current の参照 API の根拠になる。

### Account layer

account / billing / OIDC issuer / customer onboarding を提供する operator 側の層
(旧: account-plane)。

### Operator distribution

Takosumi core の周辺で account management、kind/backend
binding、policy、admin/read API、runtime behavior を提供する operator-owned
distribution。Takosumi Cloud は reference operator distribution である。

---

## Internal / Reference Implementation

### TrafficSnapshot

activation 時の routing assignment snapshot (コード: `ActivationSnapshot`)。
Space 内の Installation 群に対する routing state を 1 時点で凍結したもの。

### ObservationState

runtime 観測の accumulated state (コード: `ObservationSet`)。provider が報告する
runtime observation を蓄積し、Takosumi が reconciliation に使う。

### ResolvedPlan

manifest 解決結果の snapshot (コード: `ResolutionSnapshot`)。dry-run / apply
時に manifest を kind / binding / output material で解決した結果を保持する。

### TargetState

desired runtime state の snapshot (コード: `DesiredSnapshot`)。apply が目指す
runtime 状態を記述する。

### CleanupBacklog

revoke できなかった cleanup task の管理レコード (コード: `RevokeDebt`)。resource
side effect の取り消しが失敗した場合に記録され、operator action を要求する。

### RoutingPointer

Space-local な current TrafficSnapshot pointer (コード: `GroupHead`)。Space
内で現在有効な TrafficSnapshot を指す。

### asset

operator extension の blob storage 対象 (コード: `DataAsset`)。worker kind
とは別 workflow で管理される。

### expectedEffectsDigest

dry materialization の predicted effects digest (旧:
`predictedActualEffectsDigest`)。dry-run が返す materialization 予測の digest。

### escalation timeout

CleanupBacklog の operator-action-required 遷移期限 (旧: aging
window)。この期限を過ぎると cleanup task が operator escalation
を必要とする状態に遷移する。

### snapshot creation

journal compaction の snapshot 作成工程 (旧: Snapshotization)。journal entry
を集約して snapshot を作成する internal compaction process。

### before resource side effects

リソースの作成・更新の開始前の fail-closed 検証タイミング。kind alias resolution
miss やバリデーション失敗をこのタイミングで reject
し、リソースの作成・更新が発生する前に操作を中止する。
