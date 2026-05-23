# Namespace Export モデル {#namespace-export-model}

> このページでわかること: namespace export のモデル定義と使い方。

Root-level canonical spec: [Namespace Exports](../namespace-exports.md).

Export は namespace アドレス可能な usable surface である。namespace path は
Space の中で解決される。producer は export declaration を publish し、link
materialization は export material を生成する。

## Namespace path 文法 {#namespace-path-grammar}

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment("." segment)*
```

Rules:

- max segments: 8
- max path length: 255
- component names are single segments
- empty segments are invalid
- `default` is allowed only as an export leaf
- reserved namespace prefixes are operator-controlled and Space-visible only
  when granted by operator policy

Reserved prefixes:

```text
operator
system
```

Product-specific prefixes such as `takos.*` are ordinary operator-distribution
examples.

## ExportDeclaration と ExportMaterial {#exportdeclaration-vs-exportmaterial}

### ExportDeclaration {#exportdeclaration}

declaration は何が使えるかを宣言する。

```yaml
ExportDeclaration:
  snapshotId: export-snapshot:...
  path: operator.database.primary
  spaceId: space:acme-prod
  scope: environment:prod
  owner:
    kind: operator
    id: reference-operator
  descriptorDigest: sha256:...
  sensitivity: secret | restricted | public
  defaultProjection: null
  projectionVariants: []
  effectFamilies:
    - grant
    - secret
  effectDetails: {}
  accessModes:
    - read
    - read-write
  safeDefaultAccess: null
  freshness:
    state: fresh | stale | revoked | unknown
    observedAt: ...
```

### ExportMaterial {#exportmaterial}

material は link materialization によって生成される。

```yaml
ExportMaterial:
  linkId: link:api.DATABASE_URL
  exportSnapshotId: export-snapshot:...
  secretRefs: []
  endpointRefs: []
  grantHandles: []
  runtimeHandles: []
  sdkConfigRefs: []
```

Resolution は declaration を保存する。OperationJournal と observation が
material を追跡する。

## デフォルト export {#default-export}

bare な namespace path は default export が存在するときにのみ `.default` に
展開される。

```text
operator.identity -> operator.identity.default
```

default export は safe read access を基本にする。grant を生む default は
`safeDefaultAccess` を明示する。`read-write` と `admin` は明示 grant で扱う。

## Space-scope namespace 解決 {#space-scoped-namespace-resolution}

namespace resolution は常に Space の中で行われる。別 Space の同じ path は別の
subject である。current v1 の依存は Space に許可された operator 所有の namespace
export に限られる。

```text
1. deployment-local object namespace
2. deployment-local generated namespace
3. group namespace
4. environment namespace, if defined by the Space
5. space namespace
6. operator namespace granted to the Space
7. reserved: explicitly shared namespace imports from another Space
```

shadowing は policy で gate される。production では意味のある shadowing は
拒否するか承認を要求すべきである。特にローカル namespace が Space / operator /
external namespace を shadow するケース。

## Space export の共有 {#space-export-sharing}

current v1 の namespace resolution は Space-local です。Space を跨ぐ namespace
使用は reserved sharing model として扱います。

```yaml
fromSpaceId: space:platform
toSpaceId: space:acme-prod
exportPath: operator.identity.oauth
exportSnapshotId: export-snapshot:...
allowedAccess:
  - read
  - invoke-only
```

share と plan 出力は Space を跨ぐ使用を risk として明示しなければならない。

## Freshness {#freshness}

```text
fresh:
  usable

stale:
  policy decides allow-with-warning, require-refresh, or deny

revoked:
  deny

unknown:
  policy decides require-refresh or deny
```

## Data Asset モデル {#data-asset-model}

DataAsset は Object や Operation が使うコンテンツ・入力を表す。DataAsset の可
視性は Space scope であり、operator の DataAsset policy が明示的に共有を許可し
た場合のみ scope を超える。

### v1 の対象範囲 {#v1-の対象範囲}

Public v1 の kernel がサポートするもの:

```text
prepared source snapshot
operator-owned data asset upload
operator-registered data asset metadata
```

source build は BuildSpec を読む build service または CI が実行し、kernel v1 は
prepared source snapshot を受け取る。

### DataAsset kind {#dataasset-kind}

```yaml
DataAsset:
  spaceId: space:acme-prod
  id: asset:...
  kind: string # operator-defined metadata
  digest: sha256:...
  uri: optional
  source: optional
```

DataAsset metadata `kind` は open value で、`registerArtifactKind` /
`GET /v1/artifacts/kinds` から discover できる。

### Connector 契約 {#connector-contract}

connector は、DataAsset の bytes を implementation の手の届く範囲に持ち込む、
operator がインストールする binding である。connector は AppSpec では
ユーザー命名されない。resolution 中に選ばれた implementation から参照される。

```yaml
Connector:
  id: connector:cloudflare-workers # connector:<id>, operator-controlled
  acceptedArtifactKinds: []
  spaceVisibility: operator-policy-driven # which Spaces may use this connector
```

Identity rule:

- connector は `connector:<id>` の形でアドレッシングされる。id は operator が
  管理し、ユーザー AppSpec からは決して選ばない。
- DataAsset-backed connector は `acceptedArtifactKinds`
  ベクトルを宣言する。source-backed connector は prepared source locator と
  kind-specific `spec` を読む。
- connector の可視性は operator policy 経由で Space scope である。ある Space で
  見える connector は、その Space の visibility として扱う。
  [Operator Boundaries](./operator-boundaries.md) を参照。
- connector は AppSpec 経由でインストール・差し替え・revoke されること
  はなく、必ず operator surface から導入される。

### Source 解決 {#source-resolution}

build service は prepared source snapshot を作り、digest を Installer API に
渡す。AppSpec の path は snapshot 内の source-root-relative path として扱う。

```text
.takosumi.build.yml -> build service -> app.tar
  -> source: { kind: prepared, url, digest }
```

Transform は operator が承認する operation で、将来の operator surface 用に予
約されている。

```text
source archive -> prepared source snapshot
```

Transform operation はポリシーで明示承認されていない限り、runtime secret を受
け取ってはいけない。

#### Transform approval enforcement

Transform 承認は
[Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal)
の `pre-commit` ステージで強制される。pre-commit verification ステップは
transform を承認した approval を再検証する。
[Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
の approval invalidation trigger のいずれかが発火した場合、外部 transform 呼び
出しが始まる前に operation は fail-closed で失敗する。

transform が有効な承認なしに `pre-commit` に到達したときに surface される Risk
は `transform-unapproved` である。

### Accepted asset 検証 {#accepted-asset-検証}

Plan は関連するすべての layer を検証しなければならない。

```text
selected kind descriptor accepted data asset kinds
selected provider implementation accepted data asset kinds
connector accepted data asset kinds
DataAsset policy limits
```

### Space 可視性 {#space-可視性}

DataAsset は global store に保存されうる。`ResolutionSnapshot` は Space に可視な
DataAsset reference を記録する。Space を跨ぐ DataAsset 再利用は operator の
DataAsset policy を必要とし、resolution に記録されなければならない。

## Exposure Activation モデル {#exposure-activation-model}

public ingress を持つ component は 1 つの Space の中に Exposure intent
を作成する。 public AppSpec では、これは `custom-domain` のような component と
`listen` の `as: target` で表現され、別の top-level `expose` object ではなく
component / listen の convention で表現する。Exposure は Link と別の runtime
object です。

### Exposure

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
      compatibilityDate: "2025-01-01"
    publish:
      - com.example.app.web
  domain:
    kind: custom-domain
    spec:
      name: app.example.com
    listen:
      com.example.app.web:
        as: target
```

resolver はこれを `web` resource output を target にした `app.example.com` の
Exposure record に変換する。Exposure は外部 ingress を準備するが、それだけで
deployment を current にはしない。

### Apply と activation {#apply-vs-activation}

```text
apply:
  prepare objects, links, generated grants, generated credentials, exposure material

activate:
  update traffic assignment, activation snapshot, and Space-local GroupHead

post-activate observe:
  verify route health and active assignment
```

### Space ルール {#space-rule}

Exposure 所有権、ingress 予約、route の materialization、ActivationSnapshot、
GroupHead は Space-local である。operator の route policy が shared ownership や
delegation を許可しない限り、2 つの Space が同じ global ingress を主張する
ことはできない。

```text
GroupHead identity = spaceId + groupId
```

current v1 の traffic assignment は Space-local です。

### Exposure が生成する object {#exposure-generated-objects}

Exposure の materialization は generated object を作成しうる。

```text
IngressReservation
DnsMaterialization
TlsMaterialization
ProviderIngressObject
TrafficAssignment
```

各 generated object は owner、reason、決定的 id、delete policy を持つ。

```yaml
GeneratedObject:
  owner: exposure:web
  reason: tls-materialization
  deletePolicy: delete-with-owner | retain-with-approval
```

### ActivationSnapshot {#activationsnapshot}

```yaml
ActivationSnapshot:
  id: activation:...
  desiredSnapshotId: desired:...
  assignments: []
  activatedAt: ...
  health: unknown | healthy | degraded | unhealthy
  sourceObservationDigest: sha256:... # latest observation feeding `health`
```

`sourceObservationDigest` は現在の `health` 注記を生成した ObservationSet entry
を記録する。これは runtime reality を snapshot に結びつける唯一の authoritative
な link である。ObservationSet entry は `assignments` を変更しない。

GroupHead は apply phase の再検証と activation policy の通過後にのみ動く。

### Activate 後の health state {#post-activate-health-state}

activation 後、exposure は closed v1 persisted health enum を通じて runtime
reality を追跡する。`observing` は worker 内部の transient state で、persisted
health enum は `unknown | healthy | degraded | unhealthy` です。状態遷移は
[Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal)
の `observe` stage が ObservationSet に append する entry
によってのみ駆動される。 どの状態遷移も DesiredSnapshot を変更しない。

```text
unknown → healthy
       \ → degraded
       \ → unhealthy

healthy   ↔ degraded ↔ unhealthy   (re-entry on observation change)
```

| state       | meaning                                               |
| ----------- | ----------------------------------------------------- |
| `unknown`   | no observation recorded yet (pre-first-probe)         |
| `healthy`   | latest observation confirms the desired assignment    |
| `degraded`  | partial signal; some checks pass, some fail           |
| `unhealthy` | latest observation contradicts the desired assignment |

`unhealthy` の effect:

- `unhealthy` は DesiredSnapshot を書き換えない。DriftIndex と
  ActivationSnapshot 上の注記に流れるだけ。
- `unhealthy` は将来の activation が開始する新規 traffic shift を block する
  (approval で明示的に override されない限り)。既存の GroupHead pointer は
  自動的には rollback されない (fail-safe-not-fail-closed)。
- この state から drift entry がどう作られるかは
  [Drift Detection](../drift-detection.md) を参照。
