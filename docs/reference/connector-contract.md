# Connector 契約 {#connector-contract}

> このページでわかること: connector plugin の実装契約。

Connector は、 prepared source や operator-owned DataAsset を外部 runtime
(serverless host、 container orchestrator、 object storage backend など) に
materialize する operator がインストールするソフトウェアユニットである。 apply
時にクラウド / プラットフォーム credential を保持できるのは Connector
だけであり、 kernel 自身は保持しない。 本リファレンスは v1 Connector の
identity、 runtime-agent addressing、 record schema、 source/data input、 Space
visibility ルール、 envelope バージョニング、 そして Connector lifecycle
を管理する operator 専用 operation を定義する。

## アイデンティティ {#identity}

A Connector identity has the closed shape:

```text
connector:<id>
```

`<id>` segment は operator が管理する inventory identity です。ユーザーが命名
することはなく、AppSpec 入力から導出されず、ユーザー作成 AppSpec に現れること
もありません。runtime-agent lifecycle RPC の dispatch key は `connector:<id>`
ではなく既存 wire shape の `(shape, provider)` です。

ユーザーは component kind / spec を書き、operator distribution の resolver が
shape/provider と Space visibility に bound された Connector 実装を選びます。

Identity rules:

- `connector:<id>` is globally unique within the operator installation.
- The same `<id>` value never points to a different Connector code path across
  versions; replacement always goes through the operator `replace` operation,
  which carries an explicit version vector and envelope guard.
- `connector:` is a reserved prefix. No plugin or user AppSpec may mint
  identities under this prefix. Plan rejects AppSpecs that attempt to.
- `connector:<id>` is not a lifecycle dispatch address. Runtime-agent calls
  always address a connector by `(shape, provider)`.

## Connector レコード {#connector-record}

各 Connector は、 kernel が起動時に operator がインストールした Connector
registry から読む record で記述される。

```yaml
Connector:
  id: connector:cloudflare-workers
  shape: worker@v1
  provider: cloudflare-workers
  acceptedArtifactKinds: []
  spaceVisibility: operator-policy-driven
  envelopeVersion: v1
```

Field semantics:

- `id` (required): The full `connector:<id>` identity.
- `shape` (required): runtime-agent lifecycle shape, for example `worker@v1`.
- `provider` (required): runtime-agent provider id, for example
  `cloudflare-workers`.
- `acceptedArtifactKinds` (required): operator DataAsset metadata values the
  Connector accepts. Empty array means the Connector reads source/spec directly
  instead.
- `spaceVisibility` (required): `operator-policy-driven` (default) または closed
  Space-set descriptor。
- `envelopeVersion` (required): この Connector が喋る control envelope version。
  現状は `v1`。

所与の Connector インスタンスについて record は immutable である。
`acceptedArtifactKinds` を広げたい、 envelope version を変えたい operator は
Connector `replace` operation を実行する。kernel は同じ `connector:<id>`
identity に bound された新規 Connector record として扱う。以前の record は audit
と replay 用に保持される。

## Source / Data Inputs {#source-data-inputs}

`acceptedArtifactKinds` ベクトルは、DataAsset-backed connector が consume できる
operator-owned DataAsset metadata value を列挙する互換 field です。DataAsset
metadata value は operator extension の registry で管理され、connector が
`acceptedArtifactKinds` で受け付ける値を選びます。source-backed connector は
`acceptedArtifactKinds: []` とし、`LifecycleApplyRequest.preparedSource`
から必要な file を読みます。

例: reference `worker@v1` connector は `spec.entrypoint` を prepared source から
読みます。worker は DataAsset descriptor を要求せず、entrypoint file は prepared
source snapshot 内に置きます。

per-metadata size cap、 registered metadata、 discovery API は
[Data Assets](./kind-registry.md#data-assets) を参照。

Plan-time enforcement:

- A DataAsset-backed request whose operator DataAsset metadata `kind` is not in
  `acceptedArtifactKinds` is rejected with an `artifact_kind_mismatch` error.
- Adding a new DataAsset metadata value to an operator installation requires
  registering discovery metadata with `registerArtifactKind`; a Connector must
  still explicitly list the value in `acceptedArtifactKinds` before it can
  consume it.

source-backed connector の input contract は shape-specific `spec` と prepared
source locator で決まる。provider implementation / connector binding
のマッチングは resolver を通る。

## Space 可視性 {#space-visibility}

Connector はグローバルに addressing できない。 可視性は operator policy
が制御し、 Space ごとに resolve される。

- `spaceVisibility: operator-policy-driven` (the default): the kernel consults
  operator policy at resolve time to determine which Spaces see this Connector.
  Different Spaces, including parent and child Spaces, may see different
  Connector sets.
- `spaceVisibility: <closed Space-set descriptor>`: the Connector is visible
  only to Spaces matching the descriptor. Reserved-prefix Spaces (`takos`,
  `operator`, `system`) are governed by the same descriptor semantics.

Resolver behaviour:

- Provider / connector resolution that selects only Connectors invisible to the
  active Space fails with a closed plan error before runtime-agent dispatch.
- The set of Connectors visible to a Space is recorded in the ResolutionSnapshot
  for replay; replay against a different visibility state surfaces a
  deterministic divergence.
- Visibility changes never mutate an existing ResolutionSnapshot. They surface
  on the next deploy through a new snapshot.

operator はアドホックな Space 設定ではなく policy から visibility を駆動する
ことが期待される。 これにより Space レベル policy が監査可能になり、 resolver
も決定的に保たれる。

## エンベロープバージョニング {#envelope-versioning}

Connector は runtime-agent との間で control envelope を喋る。 envelope は kernel
HTTP API とは独立にバージョンが付く。

- v1 is the only envelope version defined for the v1 release.
- A future breaking envelope change must update the connector spec,
  runtime-agent dispatch, docs, and tests in the same change set.
- Current docs do not publish a parallel v1/v2 operation promise. If a future
  release needs multiple envelope versions, that behavior must be defined as a
  new current contract instead of an implicit dual-run period.

v1 の apply / destroy envelope では、 呼び出しが public OperationJournal path
から来るとき runtime-agent request は WAL 由来の `idempotencyKey` を運ぶ。 同じ
operation tuple は `operationRequest` と `metadata.takosumiOperation` (`phase`、
`walStage`、 `operationId`、 `resourceName`、 `providerId`、
`operationPlanDigest`、 raw tuple) からも得られる。 Connector は同じキーでの
繰り返し呼び出しを同一の論理 side effect として扱い、 request-token semantics
を公開するクラウド API にキーを forward しなければならない。

envelope version は Connector record の一部です。Connector は envelope upgrade
を 跨いで `connector:<id>` を保つ。 upgrade path は `replace` operation で、
以前と新規の envelope version の両方 を記録する。

## オペレーター専用オペレーション {#operator-only-operations}

次の Connector operation は operator surface に予約されている。 ユーザー作成
AppSpec から address できず、 public CLI deploy path にも公開されない。

- `install`: register a new `connector:<id>` with its initial record. Records
  the install in the audit log under `connector-registered`.
- `replace`: bind a new Connector record to an existing `connector:<id>`.
  Records the replacement in the audit log under `connector-replaced`. The
  replacement is rejected if it would shrink `acceptedArtifactKinds` while
  bindings exist that depend on the removed metadata values, unless the operator
  passes an explicit drain plan.
- `revoke`: remove a `connector:<id>` from the active registry. Records the
  revocation in the audit log under `connector-revoked`. Existing
  ActivationSnapshots that reference the revoked Connector remain replayable;
  new resolutions targeting the revoked identity fail.

operator 専用 operation は deploy bearer ではなく operator bearer で gate
される。 runtime-agent はユーザーに代わってこれらの operation を実行しない。

## KernelPlugin からの利用 {#kernelplugin-consumption}

KernelPlugin は Connector の下流 consumer (= kernel 側の materializer plugin)
である。AppSpec author は Connector を直接選ばず、operator distribution の
resolution が provider implementation / Connector binding を選ぶ。

- A KernelPlugin declares the `connector:<id>` identities it depends on. The
  kernel resolves each declared identity at apply time and rejects the apply if
  any declared Connector is not visible to the active Space.
- KernelPlugin receives the resolved Connector record (`id`, `shape`,
  `provider`, `acceptedArtifactKinds`, `envelopeVersion`) but never the
  Connector's credentials. Credentials remain inside the runtime-agent host.
- A KernelPlugin must not invent new `connector:<id>` identities. Plugins that
  need a new Connector raise the request through the operator `install`
  operation.

kernel-side materializer (= `KernelPlugin`) の record schema と registration API
は [Providers](./providers.md) を参照。

## Runtime-Agent ホスティング {#runtime-agent-hosting}

runtime-agent は Connector を in-process モジュールとして host する。

- Each Connector is loaded once per runtime-agent boot. The
  `(shape, provider, acceptedArtifactKinds)` tuple is exposed at
  `GET /v1/connectors`.
- The runtime-agent dispatches lifecycle calls (`apply`, `destroy`, `describe`,
  `verify`) to the Connector module by `(shape, provider)`. `connector:<id>`
  remains operator inventory identity only.
- Connector code never reaches the kernel host. The kernel calls into the
  runtime-agent over the lifecycle envelope, and the runtime-agent calls into
  the Connector module.
- Source-backed connectors read from `preparedSource`; DataAsset-backed
  connectors may fetch bytes through the operator DataAsset extension using
  `TAKOSUMI_ARTIFACT_FETCH_TOKEN`.

lifecycle envelope の wire format と error code enum は
[Runtime-Agent API](./runtime-agent-api.md) を参照。

## 関連アーキテクチャ {#related-architecture-notes}

- `reference/architecture/namespace-export-model#data-asset-model` — the
  rationale for operator-installed Connectors, accepted-kind vectors, and Space
  visibility.
- `reference/architecture/operator-boundaries` — the trust split that keeps
  Connector credentials in the runtime-agent host.
- `reference/architecture/operator-boundaries` — KernelPlugin authoring patterns
  that consume Connectors.

## 関連ページ

- [Data Assets](./kind-registry.md#data-assets)
- [Providers](./providers.md)
- [Runtime-Agent API](./runtime-agent-api.md)
- [Audit Events](./audit-events.md)
