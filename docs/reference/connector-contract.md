# Reference Runtime-Agent Connector Guide {#connector-contract}

This page is reference implementation guidance, not the Takosumi core public
Installer contract. Compatible installers do not have to expose Connector
lifecycle operations or use the `connector:<id>` inventory format.

Reference runtime-agent path における Connector は、 prepared source や
operator-owned DataAsset を外部 runtime (serverless host、 container
orchestrator、 object storage backend など) に materialize する operator が
インストールするソフトウェアユニットです。credential の共通不変条件は、cloud /
OS credential を Takosumi kernel process に置かないことです。reference
runtime-agent path では credential は Connector / runtime-agent host に置きます
が、別 implementation は operator-owned execution host など別の kernel-external
場所に置けます。本リファレンスは v1 Connector の identity、 runtime-agent
addressing、 record schema、 source/data input、 Space visibility ルール、
envelope バージョニング、そして Connector lifecycle を管理する operator 専用
operation を説明します。

## アイデンティティ {#identity}

A Connector inventory id in the reference runtime-agent registry uses this
current compatibility format:

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

Reference registry rules:

- `connector:<id>` is globally unique within the operator installation.
- The same `<id>` value never points to a different Connector code path across
  versions; replacement always goes through the operator `replace` operation,
  which carries an explicit version vector and envelope guard.
- The `connector:<id>` format belongs to the reference operator registry. User
  AppSpec does not mint or address Connector identities.
- Runtime-agent calls address a connector by `(shape, provider)`.

## Connector レコード {#connector-record}

reference runtime-agent implementation では、各 Connector は operator が
インストールした Connector registry record で記述されます。

```yaml
Connector:
  id: connector:cloudflare-workers
  shape: worker@v1
  provider: cloudflare-workers
  acceptedArtifactKinds: []
  spaceVisibility: operator-policy-driven
  envelopeVersion: v1
```

Reference registry field semantics:

- `id`: The full `connector:<id>` identity.
- `shape`: runtime-agent lifecycle selector, for example `worker@v1`.
- `provider`: runtime-agent provider id, for example `cloudflare-workers`.
- `acceptedArtifactKinds`: operator DataAsset metadata values the Connector
  accepts. Empty array means the Connector reads source/spec directly instead.
- `spaceVisibility`: `operator-policy-driven` (default) または Space-set
  descriptor。
- `envelopeVersion`: この Connector が喋る control envelope version。現状は
  `v1`。

所与の Connector インスタンスについて record は immutable である。
`acceptedArtifactKinds` を広げたい、 envelope version を変えたい operator は
Connector `replace` operation を実行する。reference runtime-agent path は同じ
`connector:<id>` identity に bound された新規 Connector record として扱う。以前
の record は audit と replay 用に保持される。

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
[DataAsset Policy](./data-asset-policy.md#accepted-kind-policy) を参照。

DataAsset は optional operator extension の概念名です。`acceptedArtifactKinds`
や `artifact_kind_mismatch` のような `artifact*` wire names は compatibility
名です。

dry-run / apply resolution enforcement:

- A DataAsset-backed request whose operator DataAsset metadata `kind` is not in
  `acceptedArtifactKinds` is rejected with an `artifact_kind_mismatch` error.
- The reference DataAsset extension registers discovery metadata with
  `registerArtifactKind`. Other operator implementations can use another
  discovery registry; the connector-facing resolver still checks the accepted
  metadata set before dispatch.

source-backed connector の input contract は connector-specific `spec` と
resolved source locator で決まる。provider implementation / connector binding
のマッチングは resolver を通る。

## Space 可視性 {#space-visibility}

Connector は user / AppSpec から addressing できない。可視性は operator policy
が制御し、 Space ごとに resolve される。

- `spaceVisibility: operator-policy-driven` (the default): the kernel consults
  operator policy at resolve time to determine which Spaces see this Connector.
  Different Spaces, including parent and child Spaces, may see different
  Connector sets.
- `spaceVisibility: <closed Space-set descriptor>`: the Connector is visible
  only to Spaces matching the descriptor. Operator-defined Space-set descriptors
  are policy metadata and are separate from public AppSpec external publication
  paths.

Resolver behaviour:

- Provider / connector resolution that selects only Connectors invisible to the
  active Space fails with a closed plan error before runtime-agent dispatch.
- The reference resolver records the set of Connectors visible to a Space as
  retained evidence for replay; replay against a different visibility state
  surfaces a deterministic divergence.
- Visibility changes never mutate existing retained evidence. They surface on
  the next deploy through a new resolution record.

operator はアドホックな Space 設定ではなく policy から visibility を駆動する
ことが期待される。これにより Space レベル policy が監査可能になり、 resolver
も決定的に保たれる。

## Reference envelope versioning {#envelope-versioning}

Connector は runtime-agent との間で control envelope を喋る。 envelope は kernel
HTTP API とは独立にバージョンが付く。

- `v1` is the reference runtime-agent envelope version for this release line.
- A breaking envelope change updates the connector guide, runtime-agent
  dispatch, docs, and tests together.
- A distribution that supports multiple envelope versions records that support
  explicitly in the Connector registry.

v1 の apply / destroy envelope では、reference kernel の internal WAL dispatch
path から来る runtime-agent request が WAL 由来の `idempotencyKey` を運ぶ。
Installer API には user-supplied `Idempotency-Key` header はありません。同じ
operation tuple は `operationRequest` と `metadata.takosumiOperation` (`phase`、
`walStage`、 `operationId`、 `resourceName`、 `providerId`、
`operationPlanDigest`、 raw tuple) からも得られる。 Connector は同じキーでの
繰り返し呼び出しを同一の論理 side effect として扱い、 request-token semantics
を公開するクラウド API にキーを forward しなければならない。

envelope version は Connector record の一部です。Connector は envelope upgrade
を跨いで `connector:<id>` を保つ。 upgrade path は `replace` operation で、
以前と新規の envelope version の両方を記録する。

## Reference registry operator operations {#operator-only-operations}

次の Connector operation は current reference connector registry の operator
surface に予約されている。ユーザー作成 AppSpec から address できず、public CLI
deploy path にも公開されない。別 implementation は別の inventory / lifecycle
管理方式を使えます。

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

operator 専用 operation は Installer bearer や DataAsset writer token ではなく
operator bearer で gate される。 runtime-agent はユーザーに代わってこれらの
operation を実行しない。

## Reference kernel adapter からの利用 {#kernelplugin-consumption}

Reference kernel adapter (`KernelPlugin`) は Connector の下流 consumer (= kernel
側の implementation adapter) です。AppSpec author は Connector を直接選ばず、
operator distribution の resolution が provider implementation / Connector
binding を選びます。

- A reference adapter declares the `connector:<id>` identities it depends on.
  The current reference resolver checks each declared identity at apply time and
  rejects the apply if any declared Connector is not visible to the active
  Space.
- The reference adapter receives the resolved Connector record (`id`,
  connector-local selector fields, `acceptedArtifactKinds`, `envelopeVersion`)
  but never the Connector's credentials. Credentials remain inside the
  runtime-agent host or another kernel-external execution host selected by the
  operator implementation.
- A reference adapter must not invent new `connector:<id>` identities. Adapters
  that need a new Connector raise the request through the operator `install`
  operation.

kernel-side implementation adapter (`KernelPlugin`) の record schema と
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
[Reference Runtime-Agent Execution Surface](./runtime-agent-api.md) を参照。

## 関連アーキテクチャ {#related-architecture-notes}

- `reference/data-asset-policy` — DataAsset metadata policy and accepted-kind
  vectors.
- `reference/architecture/operator-boundaries` — operator-installed Connectors
  and Space visibility.
- `reference/architecture/operator-boundaries` — the trust split that keeps
  Connector credentials in the runtime-agent host.
- `reference/architecture/operator-boundaries` — reference adapter authoring
  patterns that consume Connectors.

## 関連ページ

- [DataAsset Policy](./data-asset-policy.md)
- [Providers](./providers.md)
- [Reference Runtime-Agent Execution Surface](./runtime-agent-api.md)
- [Audit Events](./audit-events.md)
