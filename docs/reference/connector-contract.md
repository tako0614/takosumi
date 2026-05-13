# Connector Contract

> このページでわかること: connector plugin の実装契約。

Connector は、DataAsset を外部 runtime (serverless host、container
orchestrator、 object storage backend など) に materialize する operator
がインストールする ソフトウェアユニットである。apply 時にクラウド /
プラットフォーム credential を 保持できるのは Connector だけであり、kernel
自身は保持しない。本リファレンスは v1 Connector の identity、record
schema、accepted-kind vector、Space visibility ルール、signing
expectation、envelope バージョニング、Connector lifecycle を 管理する operator
専用 operation を定義する。

## Identity

A Connector identity has the closed shape:

```text
connector:<id>
```

`<id>` segment は operator が管理する。ユーザーが命名することはなく、manifest
入力から導出されず、ユーザー作成 manifest に現れることもない。ユーザーは
Implementation を選び、resolver が Implementation の accepted-kind vector と
Space visibility に bound された Connector を選ぶ。

Identity rules:

- `connector:<id>` is globally unique within the operator installation.
- The same `<id>` value never points to a different Connector code path across
  versions; replacement always goes through the operator `replace` operation,
  which carries an explicit version vector and envelope guard.
- `connector:` is a reserved prefix. No plugin, template, or user manifest may
  mint identities under this prefix. Plan rejects manifests that attempt to.

## Connector record

各 Connector は、kernel が起動時に operator がインストールした Connector
registry から読む record で記述される。

```yaml
Connector:
  id: connector:cloudflare-workers-bundle
  acceptedKinds: [js-bundle]
  spaceVisibility: operator-policy-driven
  signingExpectations: optional
  envelopeVersion: v1
```

Field semantics:

| Field                 | Required | Meaning                                                                     |
| --------------------- | -------- | --------------------------------------------------------------------------- |
| `id`                  | yes      | The full `connector:<id>` identity.                                         |
| `acceptedKinds`       | yes      | Artifact kind strings the Connector accepts.                                |
| `spaceVisibility`     | yes      | Either `operator-policy-driven` (default) or a closed Space-set descriptor. |
| `signingExpectations` | yes      | One of `none`, `optional`, `required`.                                      |
| `envelopeVersion`     | yes      | The control envelope version this Connector speaks, currently `v1`.         |

所与の Connector インスタンスについて record は immutable である。
`acceptedKinds` を広げたい / signing expectation を上げたい / envelope version
を変えたい operator は Connector `replace` operation を実行する。kernel は
これを同じ `connector:<id>` identity に bound された新規 Connector record と
して扱い、以前の record は audit と replay 用に保持される。

## Accepted-kind vector

`acceptedKinds` ベクトルは、この connector が consume できる artifact kind を
列挙する。`Artifact.kind` は protocol 層では open で、同梱の kind registry は
次から始まる。

```text
oci-image | js-bundle | lambda-zip | static-bundle | wasm
```

See [DataAsset Kinds](/reference/artifact-kinds) for the per-kind size caps,
registered metadata, and discovery API.

Plan-time enforcement:

- A Link or DataAsset binding whose `kind` is not in `acceptedKinds` is rejected
  with an `artifact_kind_mismatch` plan error.
- Adding a new kind to an operator installation requires registering discovery
  metadata with `registerArtifactKind`; a Connector must still explicitly list
  the kind in `acceptedKinds` before it can consume it.

accepted-kind ベクトルは、Connector がどの artifact を materialize するかを
宣言する唯一の仕組みである。Implementation のマッチングは resolver を通る:
Implementation も自身の accepted-kind ベクトルを宣言し、resolver は各候補
Connector のベクトルと積集合を取ってから binding する。

## Space visibility

Connector はグローバルに addressing できない。可視性は operator policy が制御
し、Space ごとに resolve される。

- `spaceVisibility: operator-policy-driven` (the default): the kernel consults
  operator policy at resolve time to determine which Spaces see this Connector.
  Different Spaces, including parent and child Spaces, may see different
  Connector sets.
- `spaceVisibility: <closed Space-set descriptor>`: the Connector is visible
  only to Spaces matching the descriptor. Reserved-prefix Spaces (`takos`,
  `operator`, `system`) are governed by the same descriptor semantics.

Resolver behaviour:

- A manifest that references an Implementation whose only candidate Connector is
  invisible to the active Space fails resolution with a closed plan error.
- The set of Connectors visible to a Space is recorded in the ResolutionSnapshot
  for replay; replay against a different visibility state surfaces a
  deterministic divergence.
- Visibility changes never mutate an existing ResolutionSnapshot. They surface
  on the next deploy through a new snapshot.

operator はアドホックな Space 設定ではなく policy から visibility を駆動する
ことが期待される。これにより Space レベル policy が監査可能になり、resolver も
決定的に保たれる。

## Signing expectations

`signingExpectations` field は、Connector が受け付ける artifact に対して何を
要求するかを宣言する。

| Value      | Meaning                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `none`     | Connector accepts unsigned artifacts. Per-key artifact policy may still mandate signing.                        |
| `optional` | Connector accepts both signed and unsigned artifacts. Plan logs the absence of a signature but does not reject. |
| `required` | Connector rejects unsigned artifacts at plan time.                                                              |

signing expectation は current v1 では connector のメタデータである。Artifact
署名の検証自体は operator がインストールした signing backend が行い、Connector
record はその期待を宣言するだけである。

## Envelope versioning

Connector は runtime-agent との間で control envelope を喋る。envelope は kernel
HTTP API とは独立にバージョンが付く。

- v1 is the only envelope version defined for the v1 release.
- A future breaking envelope change must update the connector spec,
  runtime-agent dispatch, docs, and tests in the same change set.
- Current pre-GA docs do not publish a parallel v1/v2 operation promise. If a
  future release needs multiple envelope versions, that behavior must be defined
  as a new current contract instead of an implicit migration window.

v1 の apply / destroy envelope では、呼び出しが public OperationJournal path
から来るとき runtime-agent request は WAL 由来の `idempotencyKey` を運ぶ。同じ
operation tuple は `operationRequest` と `metadata.takosumiOperation`
(`phase`、`walStage`、`operationId`、
`resourceName`、`providerId`、`operationPlanDigest`、raw tuple) からも得られる。
Connector は同じキーでの繰り返し呼び出しを同一の論理 side effect として扱い、
request-token semantics を公開するクラウド API にキーを forward しなければ
ならない。

envelope version は Connector record の一部であり、Connector identity の一部
ではない。Connector は envelope upgrade を跨いで `connector:<id>` を保つ。
upgrade path は `replace` operation で、以前と新規の envelope version の両方を
記録する。

## Operator-only operations

次の Connector operation は operator surface に予約されている。ユーザー作成
manifest から address できず、public CLI deploy path にも公開されない。

- `install`: register a new `connector:<id>` with its initial record. Records
  the install in the audit log under `catalog-release-adopted`.
- `replace`: bind a new Connector record to an existing `connector:<id>`.
  Records the replacement in the audit log under `catalog-release-rotated`. The
  replacement is rejected if it would shrink `acceptedKinds` while bindings
  exist that depend on the removed kinds, unless the operator passes an explicit
  drain plan.
- `revoke`: remove a `connector:<id>` from the active registry. Records the
  revocation in the audit log under `catalog-release-rotated`. Existing
  ActivationSnapshots that reference the revoked Connector remain replayable;
  new resolutions targeting the revoked identity fail.

operator 専用 operation は deploy bearer ではなく operator bearer で gate
される。runtime-agent はユーザーに代わってこれらの operation を実行しない。

## Provider plugin consumption

Provider plugin は Connector の下流 consumer である。

- A provider plugin declares the `connector:<id>` identities it depends on. The
  kernel resolves each declared identity at apply time and rejects the apply if
  any declared Connector is not visible to the active Space.
- Provider plugins receive the resolved Connector record (`id`, `acceptedKinds`,
  `signingExpectations`, `envelopeVersion`) but never the Connector's
  credentials. Credentials remain inside the runtime-agent host.
- A provider plugin must not invent new `connector:<id>` identities. Plugins
  that need a new Connector raise the request through the operator `install`
  operation.

provider plugin の record schema と registration API は
[Providers](/reference/providers) を参照。

## Runtime-Agent hosting

runtime-agent は Connector を in-process モジュールとして host する。

- Each Connector is loaded once per runtime-agent boot. The
  `(shape, provider, acceptedArtifactKinds)` tuple is exposed at
  `GET /v1/connectors`.
- The runtime-agent dispatches lifecycle calls (`apply`, `destroy`, `describe`,
  `verify`) to the Connector module by `connector:<id>`.
- Connector code never reaches the kernel host. The kernel calls into the
  runtime-agent over the lifecycle envelope, and the runtime-agent calls into
  the Connector module.
- The runtime-agent fetches artifact bytes through the kernel's artifact
  partition using `TAKOSUMI_ARTIFACT_FETCH_TOKEN`; the Connector receives bytes
  by hash, never the deploy bearer.

lifecycle envelope の wire format と error code enum は
[Runtime-Agent API](/reference/runtime-agent-api) を参照。

## Related architecture notes

- `reference/architecture/data-asset-model` — the rationale for
  operator-installed Connectors, accepted-kind vectors, and Space visibility.
- `reference/architecture/operator-boundaries` — the trust split that keeps
  Connector credentials in the runtime-agent host.
- `reference/architecture/paas-provider-architecture` — provider plugin
  authoring patterns that consume Connectors.

## 関連ページ

- [DataAsset Kinds](/reference/artifact-kinds)
- [Providers](/reference/providers)
- [Runtime-Agent API](/reference/runtime-agent-api)
- [Audit Events](/reference/audit-events)
