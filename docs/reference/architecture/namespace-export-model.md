# Namespace Export モデル {#namespace-export-model}

> このページでわかること: namespace export のモデル定義と使い方。

Root-level canonical spec: [Namespace Exports](../namespace-exports.md).

Export は namespace アドレス可能な usable surface である。namespace path は
Space の中で解決される。operator / export owner は export declaration を offer
し、link materialization は export material を生成する。

Public AppSpec v1 から参照できる namespace source は `namespace:operator.*` の
operator-owned export だけです。この architecture note は、reference
implementation が内部で使う snapshot / link / exposure record も
説明します。内部 scope stack や cross-space sharing は AppSpec grammar では
ありません。

## Namespace path 文法 {#namespace-path-grammar}

```text
segment = [a-z][a-z0-9-]{0,62}
path    = segment("." segment)*
```

Rules:

- max segments: 8
- max path length: 255
- path segment は上記 grammar の single segment
- empty segments are invalid
- `default` is allowed only as an export leaf
- reserved namespace prefixes are operator-controlled and Space-visible only
  when granted by operator policy

Public reserved prefix:

```text
operator
```

Product-specific prefixes are ordinary operator-distribution examples, not
Takosumi public namespace prefixes. `system` is reserved for internal
implementation records and is not a public `namespace:<path>` source.

## ExportDeclaration と ExportMaterial {#exportdeclaration-vs-exportmaterial}

### ExportDeclaration {#exportdeclaration}

declaration は何が使えるかを宣言する。

```yaml
ExportDeclaration:
  snapshotId: export-snapshot:...
  namespacePath: operator.database.primary
  spaceId: space:acme-prod
  owner:
    kind: operator
    id: reference-operator
  contractRef: operator.database.primary@v1
  contractVersion: v1
  descriptorDigest: sha256:...
  sensitivity: secret | restricted | public
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
  namespacePath: operator.database.primary
  secretRefs: []
  endpointRefs: []
  grantHandles: []
  runtimeHandles: []
  sdkConfigRefs: []
```

Resolution は declaration を保存する。OperationJournal と observation が
material を追跡する。

## デフォルト export {#default-export}

Public AppSpec grammar には hidden `.default` 展開はありません。AppSpec author
は `namespace:operator.observability.default` のように leaf まで明示します。
operator は `.default` leaf を持つ export を公開できますが、bare path を暗黙に
別 path へ展開する規則は v1 には置きません。

## Space-scope namespace 解決 {#space-scoped-namespace-resolution}

namespace resolution は常に Space の中で行われる。別 Space の同じ path は別の
subject である。current v1 の依存は Space に許可された operator 所有の namespace
export に限られる。

```text
1. Space-visible operator export declarations
2. absent optional binding, or required-binding failure
```

deployment-local object namespace、generated namespace、group / environment
namespace、cross-space import は internal/future vocabulary です。導入する場合も
public `namespace:<path>` の exact-match model を変えず、別 RFC で AppSpec から
見える surface を定義します。

## Space export の共有 {#space-export-sharing}

current v1 の namespace resolution は Space-local です。Space を跨ぐ namespace
使用は reserved sharing model として扱います。

```yaml
fromSpaceId: space:platform
toSpaceId: space:acme-prod
exportPath: operator.identity.oidc
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

## Source input と DataAsset extension {#data-asset-model}

Installer API の source input は `git` / `local` / `prepared` のいずれかです。
`prepared` は build service が作る portable source snapshot handoff です。
DataAsset は operator extension が保存する content-addressed blob です。
DataAsset の可視性は Space scope であり、operator の DataAsset policy が明示的に
共有を許可した場合のみ scope を超えます。

### v1 の対象範囲 {#v1-scope}

Public v1 の installer surface が扱う source input:

```text
git source
dev/operator-local source
prepared source snapshot
```

source build は BuildSpec を読む build service または CI が実行し、kernel v1 は
git / local / prepared source を受け取る。operator-owned DataAsset upload と
metadata discovery は optional operator extension surface です。

### DataAsset metadata kind {#dataasset-kind}

```yaml
DataAsset:
  spaceId: space:acme-prod
  id: asset:...
  kind: string # operator-defined metadata
  digest: sha256:...
  uri: optional
  source: optional
```

DataAsset metadata `kind` は operator-owned open value です。DataAsset extension
を有効化した distribution は、`registerArtifactKind` や
`takosumi artifact kinds` などの operator surface で discovery を提供できます。

### Connector 契約 {#connector-contract}

connector は、DataAsset の bytes を implementation の手の届く範囲に持ち込む、
operator がインストールする binding である。connector は AppSpec では
ユーザー命名されない。resolution 中に選ばれた implementation から参照される。

```yaml
Connector:
  id: connector:cloudflare-workers # connector:<id>, operator-controlled
  shape: worker@v1 # connector-local lifecycle selector
  provider: cloudflare-workers # connector-local lifecycle selector
  acceptedArtifactKinds: []
  spaceVisibility: operator-policy-driven # which Spaces may use this connector
```

Identity rule:

- connector は `connector:<id>` の形でアドレッシングされる。id は operator が
  管理し、ユーザー AppSpec からは決して選ばない。`connector:<id>` は install /
  replace / revoke 用の operator inventory identity です。
- Runtime-agent lifecycle RPC dispatch は operator resolution が選んだ
  connector-local `(shape, provider)` pair を使う。User AppSpec は connector id
  も `(shape, provider)` も選ばない。
- DataAsset-backed connector は `acceptedArtifactKinds`
  ベクトルを宣言する。source-backed connector は prepared source locator と
  kind-specific `spec` を読む。
- connector の可視性は operator policy 経由で Space scope である。ある Space で
  見える connector は、その Space の visibility として扱う。
  [Operator Boundaries](./operator-boundaries.md) を参照。
- connector は AppSpec 経由でインストール・差し替え・revoke されること
  はなく、必ず operator surface から導入される。

### Source 解決 {#source-resolution}

Installer API の `git`、`local`、`prepared` source は apply 前に resolved source
snapshot として扱う。AppSpec の path は snapshot 内の source-root-relative path
です。build service は prepared source snapshot を作り、digest を Installer API
に渡す。

```text
.takosumi.build.yml -> build service -> prepared-source.tar { digest }
  -> source: { kind: prepared, url, digest }
```

Source transforms / builds は Installer API submission 前に operator build
service、CI、automation で実行されます。Kernel v1 は git / local / prepared
source を受け取り、AppSpec を parse して Deployment evidence を記録します。
prepared source の場合は source digest を検証します。Transform approval が必要な
場合、それは build service / operator policy で扱います。

```text
source archive -> prepared source snapshot
```

Transform operation はポリシーで明示承認されていない限り、runtime secret を受
け取ってはいけない。

#### Transform approval enforcement

Transform approval は build service / operator policy の pre-submission gate
です。[Policy, Risk, Approval, and Error Model](./policy-risk-approval-error-model.md)
の approval invalidation trigger のいずれかが発火した場合、prepared source
handoff の前に build service 側で fail-closed します。

### Accepted asset 検証 {#accepted-asset-検証}

Plan は関連するすべての layer を検証しなければならない。

```text
selected kind descriptor accepted data asset kinds
selected provider implementation accepted data asset kinds
connector accepted data asset kinds
DataAsset policy limits
```

### Space 可視性 {#space-可視性}

DataAsset は global store に保存されうる。Deployment evidence / resolution
record は Space に可視な DataAsset reference を記録する。Space を跨ぐ DataAsset
再利用は operator の DataAsset policy を必要とし、resolution に記録されなければ
ならない。

## Exposure Activation モデル {#exposure-activation-model}

Exposure は namespace export ではなく runtime routing の内部 record です。public
AppSpec からは `gateway` のような component の `listen` と kind-specific `spec`
としてだけ表現します。

public ingress を持つ component は 1 つの Space の中に Exposure intent
を作成する。public AppSpec では、これは `gateway` のような component が upstream
publication を `listen` し、listener / route rule を `spec` に持つ形で
表現する。別の top-level `expose` object は作らない。Exposure は Link と別の
runtime object です。

### Exposure

```yaml
components:
  web:
    kind: worker
    spec:
      entrypoint: dist/worker.mjs
    publish:
      http:
        as: http-endpoint
  public:
    kind: gateway
    listen:
      app:
        from: web.http
        as: upstream
    publish:
      public:
        as: http-endpoint
    spec:
      listeners:
        public:
          protocol: https
          host: app.example.com
          tls: auto
      routes:
        - listener: public
          path: /
          to: app
```

resolver はこれを `web.http` を upstream にした `app.example.com` の Exposure
record に変換する。Exposure は外部 ingress を準備するが、それだけで deployment
を current にはしない。

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
