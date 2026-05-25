# 用語集 {#glossary}

---

## Public Concepts

### Manifest

`.takosumi.yml` に書く宣言ファイル (コード: `AppSpec`)。→ [manifest](./manifest.md)

### Component

manifest 内の実行単位。公開 field: `kind` / `spec` / `publish` / `listen` の 4 field。

### Kind

component の種類を示す文字列（Takosumi は値を解釈しない）。operator が `kindAliases` で省略名 / URI を kind の定義と binding に解決する。takosumi.com の例は [Takosumi Kind Catalog Specification](./type-catalog.md)。

### Installation

Space に入った manifest の記録。current Deployment pointer を持つ。→ [Installer API](./installer-api.md)

### Deployment

1 回の apply 結果。履歴・audit・rollback に使う。rollback は過去の Deployment を根拠に current pointer を戻し、新 Deployment は作らない。

### Space

Installation を収容する isolation 単位。manifest には書かない。

### Source

manifest を含むソースツリー。Installer API に渡す source 種別: `git` / `prepared` / `local`。→ [Installer API](./installer-api.md)

### apply

dry-run 後に実行する Installation の更新操作。manifest source を Installation に反映し、Deployment record を作る。

### expected guard

レビュー済み source が apply 時に変わっていないことを検証する TOCTOU ガード。 dry-run response の reviewed-source guard として返される。apply 時に渡すと、 review した source と異なる入力を 409 で止める。deploy expected guard は `currentDeploymentId` も持ち、review 後に current pointer が変わった場合も 409 で止める。

### Publish / Listen

component 間接続。出力する側 = `publish`、受け取る側 = `listen`。 ※ 名詞としての "publication" は「publish の出力」を意味します。

### dry-run

apply せずに検証し、変更計画と digest guard を返す操作。2 endpoint。

### expected pin

dry-run response の reviewed-source guard。apply 時に渡すと、review した source と異なる入力を 409 で止める。deploy expected guard は `currentDeploymentId` も持ち、review 後に current pointer が変わった場合も 409 で止める。

### Build service handoff

manifest 外で source を prepared source archive にする build / CI convention。 build-service profile は `.takosumi.build.yml`、別 filename、hosted CI、または recipe file なしの workflow を選べます。Takosumi core は prepared source input だけを受け取ります。→ [Build service handoff](./build-spec.md)

### Current pointer

Installation が現在有効として指す retained Deployment。Installer API では `currentDeploymentId`。rollback はこの pointer を過去の `succeeded` Deployment へ戻す。

### Prepared source

build 後 source tree を archive payload として固定した handoff source。Installer API は取得した payload bytes の sha256 を resolved source identity として記録する。

### manifestDigest

`.takosumi.yml` bytes の digest (Installer API wire field)。

### fail-closed

不明入力 / 未解決 dependency を副作用前に明示的に拒否する方針。

### Operator

Takosumi を起動し、provider / credential / storage / account layer 連携を選ぶ主体。→ [Operator](../operator/)

---

## Catalog & Binding

### Output type（出力の形式）

`publish.<name>.as` が提供する出力データの型 (コード: `MaterialContract`)。例: `http-endpoint`、`service-binding`、`object-store`。 ※ ドキュメント内では「出力の形式」とも表記します。

### Injection mode（注入モード）

listen が consumer に出力データを渡す形式 (旧: projection family)。 `listen.<binding>.as` によって出力の形式を consumer runtime に渡す方法。例: `env`、`secret-env`、`config-mount`、`upstream`。 `listen.<binding>.mount` は `config-mount` のような path-based な注入が使う kind/operator-owned mount path option です。

### Binding

operator が kind URI / descriptor を concrete provider runtime や resource operation に結びつける実装側の binding (旧: implementation binding)。どの仕組みで binding を読み込むかは operator profile が選ぶ。

### Kind schema（kind の定義）

component kind の input schema、publish の出力、注入 capability、output metadata を説明する operator が採用した metadata (旧: kind descriptor)。 Takosumi Kind Catalog は JSON-LD で定義を公開する。runtime behavior は binding が持つ。 ※ ドキュメント内では「kind の定義」とも表記します。

### Kind Catalog

Takosumi の再利用可能な kind の定義の集合 (旧: official type catalog / 公式型カタログ)。`https://takosumi.com/kinds/v1/*` で JSON-LD の定義を公開する。 operator は opt-in で Space に公開し、alternative catalog も同じ core contract で扱える。

### Platform service（プラットフォームサービス）

operator が Space に公開するサービス (旧: external publication)。→ [プラットフォームサービス](./external-publications.md) ※ 「publication」を名詞で使う場合は「publish の出力」を意味します。

### PlatformServiceDeclaration

プラットフォームサービスの Space-scoped 宣言レコード (コード: `ExternalPublicationDeclaration`)。operator が Space に公開するサービスの宣言を記述する。

### Deploy record（Deployment の記録）

Deployment に紐づけて ledger に残る選択された kind の定義 / binding、publish の出力 / 実体化の結果、operator の記録。public Deployment wire が保証するのは source identity、manifest digest、status、non-secret outputs です。Deployment の記録は後続の rollback / audit / current の参照 API の根拠になります。

### Account layer

account / billing / OIDC issuer / customer onboarding を提供する operator 側の層 (旧: account-plane)。

### Operator profile

operator が選択する kind、provider、policy の bundle (旧: operator distribution)。reference operator profile として Takosumi Cloud が存在する。

---

## Internal / Reference Implementation

### TrafficSnapshot

activation 時の routing assignment snapshot (コード: `ActivationSnapshot`)。 Space 内の Installation 群に対する routing state を 1 時点で凍結したもの。

### ObservationState

runtime 観測の accumulated state (コード: `ObservationSet`)。provider が報告する runtime observation を蓄積し、Takosumi が reconciliation に使う。

### ResolvedPlan

manifest 解決結果の snapshot (コード: `ResolutionSnapshot`)。dry-run / apply 時に manifest を kind / binding / publication で解決した結果を保持する。

### TargetState

desired runtime state の snapshot (コード: `DesiredSnapshot`)。apply が目指す runtime 状態を記述する。

### CleanupBacklog

revoke できなかった cleanup task の管理レコード (コード: `RevokeDebt`)。 provider side effect の取り消しが失敗した場合に記録され、operator action を要求する。

### RoutingPointer

Space-local な current TrafficSnapshot pointer (コード: `GroupHead`)。Space 内で現在有効な TrafficSnapshot を指す。

### asset

operator extension の blob storage 対象 (コード: `DataAsset`)。worker kind とは別 workflow で管理される。

### expectedEffectsDigest

dry materialization の predicted effects digest (旧: `predictedActualEffectsDigest`)。dry-run が返す materialization 予測の digest。

### escalation timeout

CleanupBacklog の operator-action-required 遷移期限 (旧: aging window)。この期限を過ぎると cleanup task が operator escalation を必要とする状態に遷移する。

### snapshot creation

journal compaction の snapshot 作成工程 (旧: Snapshotization)。journal entry を集約して snapshot を作成する internal compaction process。

### before provider side effects

リソースの作成・更新の開始前の fail-closed 検証タイミング。kind alias resolution miss やバリデーション失敗をこのタイミングで reject し、リソースの作成・更新が発生する前に操作を中止する。
