# Reference Runtime-Agent Connector Guide {#connector-contract}

> このページでわかること: reference runtime-agent connector の実装 guide。

Connector は、 prepared source や operator-owned DataAsset を外部 runtime
(serverless host、 container orchestrator、 object storage backend など) に
materialize する operator がインストールするソフトウェアユニットです。 apply
時にクラウド / プラットフォーム credential を保持できるのは Connector
だけであり、 kernel 自身は保持しない。 本リファレンスは v1 Connector の
identity、 runtime-agent addressing、 record schema、 source/data input、 Space
visibility ルール、 envelope バージョニング、 そして Connector lifecycle
を管理する operator 専用 operation を説明します。

## アイデンティティ {#identity}

A Connector identity has the closed shape:

```text
connector:<id>
```

`<id>` segment は operator が管理する inventory identity です。ユーザーが命名
することはなく、AppSpec 入力から導出されず、ユーザー作成 AppSpec に現れること
もありません。runtime-agent lifecycle RPC の current wire field 名は
`(shape, provider)` です。

ユーザーは component kind / spec を書き、operator distribution の resolver が
connector-local selector と Space visibility に bound された Connector 実装を
選びます。

Identity rules:

- `connector:<id>` is globally unique within the operator installation.
- The same `<id>` value never points to a different Connector code path across
  versions; replacement always goes through the operator `replace` operation,
  which carries an explicit version vector and envelope guard.
- `connector:` is a reserved prefix. No implementation adapter or user AppSpec
  may mint identities under this prefix. dry-run / apply resolution rejects
  AppSpecs that attempt to.
- Runtime-agent calls address a connector by `(shape, provider)`.

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
- `shape` (required): runtime-agent lifecycle selector, for example `worker@v1`.
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
`acceptedArtifactKinds: []` とし、resolved source snapshot から必要な file を
読みます。reference runtime-agent envelope ではその source locator を
`LifecycleApplyRequest.preparedSource` field で運びます。

例: reference `worker@v1` connector は `spec.entrypoint` を source snapshot から
読みます。worker は DataAsset descriptor を要求せず、entrypoint file は source
snapshot 内に置きます。

per-metadata size cap、 registered metadata、 discovery API は
[Data Assets](./kind-registry.md#source-files-and-dataassets) を参照。

DataAsset は optional operator extension の概念名です。`acceptedArtifactKinds`
や `artifact_kind_mismatch` のような `artifact*` wire names は compatibility
名です。

dry-run / apply resolution enforcement:

- A DataAsset-backed request whose operator DataAsset metadata `kind` is not in
  `acceptedArtifactKinds` is rejected with an `artifact_kind_mismatch` error.
- Adding a new DataAsset metadata value to an operator installation requires
  registering discovery metadata with `registerArtifactKind`; a Connector must
  still explicitly list the value in `acceptedArtifactKinds` before it can
  consume it.

source-backed connector の input contract は connector-specific `spec` と
resolved source locator で決まる。provider implementation / connector binding
のマッチングは resolver を通る。

## Space 可視性 {#space-visibility}

Connector はグローバルに addressing できない。 可視性は operator policy
が制御し、 Space ごとに resolve される。

- `spaceVisibility: operator-policy-driven` (the default): the kernel consults
  operator policy at resolve time to determine which Spaces see this Connector.
  Different Spaces, including parent and child Spaces, may see different
  Connector sets.
- `spaceVisibility: <closed Space-set descriptor>`: the Connector is visible
  only to Spaces matching the descriptor. Operator-defined Space-set descriptors
  are policy metadata and are separate from public AppSpec namespace paths.

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
- A future breaking envelope change must update the connector guide,
  runtime-agent dispatch, docs, and tests in the same change set.
- Current docs do not publish a parallel v1/v2 operation promise. If a future
  release needs multiple envelope versions, that behavior must be defined as a
  new current contract instead of an implicit dual-run period.

v1 の apply / destroy envelope では、reference kernel の internal WAL dispatch
path から来る runtime-agent request が WAL 由来の `idempotencyKey` を運ぶ。
Installer API には user-supplied `Idempotency-Key` header はありません。同じ
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

## Reference kernel adapter からの利用 {#kernelplugin-consumption}

Reference kernel adapter (`KernelPlugin`) は Connector の下流 consumer (= kernel
側の materializer adapter) です。AppSpec author は Connector を直接選ばず、
operator distribution の resolution が provider implementation / Connector
binding を選びます。

- A reference adapter declares the `connector:<id>` identities it depends on.
  The kernel resolves each declared identity at apply time and rejects the apply
  if any declared Connector is not visible to the active Space.
- The reference adapter receives the resolved Connector record (`id`,
  connector-local selector fields, `acceptedArtifactKinds`, `envelopeVersion`)
  but never the Connector's credentials. Credentials remain inside the
  runtime-agent host.
- A reference adapter must not invent new `connector:<id>` identities. Adapters
  that need a new Connector raise the request through the operator `install`
  operation.

kernel-side materializer adapter (`KernelPlugin`) の record schema と
registration API は [Providers](./providers.md) を参照。

## Runtime-Agent ホスティング {#runtime-agent-hosting}

runtime-agent は Connector を in-process モジュールとして host する。

- Each Connector is loaded once per runtime-agent boot. Its connector-local
  selector and `acceptedArtifactKinds` are exposed at `GET /v1/connectors`.
- The runtime-agent dispatches lifecycle calls (`apply`, `destroy`, `describe`,
  `verify`) to the Connector module by connector-local selector.
  `connector:<id>` remains operator inventory identity.
- Connector code never reaches the kernel host. The kernel calls into the
  runtime-agent over the lifecycle envelope, and the runtime-agent calls into
  the Connector module.
- Source-backed connectors read from the resolved source snapshot carried in the
  lifecycle envelope; DataAsset-backed connectors may fetch bytes through the
  operator DataAsset extension using `TAKOSUMI_ARTIFACT_FETCH_TOKEN`.

lifecycle envelope の wire format と error code enum は
[Runtime-Agent API](./runtime-agent-api.md) を参照。

## 関連アーキテクチャ {#related-architecture-notes}

- `reference/architecture/namespace-export-model#data-asset-model` — the
  rationale for operator-installed Connectors, accepted-kind vectors, and Space
  visibility.
- `reference/architecture/operator-boundaries` — the trust split that keeps
  Connector credentials in the runtime-agent host.
- `reference/architecture/operator-boundaries` — reference adapter authoring
  patterns that consume Connectors.

## 関連ページ

- [Data Assets](./kind-registry.md#source-files-and-dataassets)
- [Providers](./providers.md)
- [Runtime-Agent API](./runtime-agent-api.md)
- [Audit Events](./audit-events.md)
