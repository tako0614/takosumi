# Reference Runtime-Agent Connector ガイド {#connector-contract}

このページは reference implementation のガイダンスであり、Takosumi の public Installer contract ではありません。互換 installer は Connector lifecycle operation を公開したり `connector:<id>` inventory format を使う必要はありません。

Reference runtime-agent path における Connector は、prepared source や operator-owned asset を外部 runtime (serverless host、container orchestrator、 object storage backend など) に実体化する operator がインストールするソフトウェアユニットです。credential の共通不変条件は、cloud / OS credential を Takosumi process に置かないことです。reference runtime-agent path では credential は Connector / runtime-agent host に置きますが、別 implementation は operator-owned execution host など別の service-external 場所に置けます。本リファレンスは v1 Connector の identity、 runtime-agent addressing、 record schema、 source/data input、 Space visibility ルール、 envelope バージョニング、そして Connector lifecycle を管理する operator 専用 operation を説明します。

## アイデンティティ {#identity}

reference runtime-agent registry における Connector inventory id は以下の current compatibility format を使います:

```text
connector:<id>
```

`<id>` segment は operator が管理する inventory identity です。ユーザーが命名することはなく、Source 入力から導出されず、source repository に現れることもありません。runtime-agent lifecycle RPC の current wire field 名は `(shape, provider)` です。

operator distribution の resolver が Source、BindingSelection、PlatformService inventory、Space visibility から connector-local selector に bound された Connector 実装を選びます。

Reference registry のルール:

- `connector:<id>` は operator installation 内でグローバルに一意である。
- 同じ `<id>` 値は version を跨いで異なる Connector code path を指すことはない。置き換えは常に operator の `replace` operation を通り、明示的な version vector と envelope guard を伴う。
- `connector:<id>` format は reference operator registry に属する。Source repository は Connector identity を作成・参照しない。
- runtime-agent の呼び出しは `(shape, provider)` で connector を指定する。

## Connector レコード {#connector-record}

reference runtime-agent implementation では、各 Connector は operator がインストールした Connector registry record で記述されます。

```yaml
Connector:
  id: connector:cloudflare-workers
  shape: worker@v1
  provider: cloudflare-workers
  acceptedArtifactKinds: []
  spaceVisibility: operator-policy-driven
  envelopeVersion: v1
```

Reference registry field の意味:

- `id`: 完全な `connector:<id>` identity。
- `shape`: runtime-agent lifecycle selector。例: `worker@v1`。
- `provider`: runtime-agent provider id。例: `cloudflare-workers`。
- `acceptedArtifactKinds`: Connector が受け付ける operator asset metadata value。空配列の場合、Connector は source / spec を直接読む。
- `spaceVisibility`: `operator-policy-driven` (default) または Space-set descriptor。
- `envelopeVersion`: この Connector が喋る control envelope version。現状は `v1`。

所与の Connector インスタンスについて record は immutable である。 `acceptedArtifactKinds` を広げたい、 envelope version を変えたい operator は Connector `replace` operation を実行する。reference runtime-agent path は同じ `connector:<id>` identity に bound された新規 Connector record として扱う。以前の record は audit と replay 用に保持される。

## Source / Data Inputs {#source-data-inputs}

`acceptedArtifactKinds` ベクトルは、asset-backed connector が consume できる operator-owned asset metadata value を列挙する current compatibility field です。ここでの `Kinds` は asset metadata value の互換 wire name であり、Takosumi Source vocabulary ではありません。asset metadata value は operator extension の registry で管理され、connector が `acceptedArtifactKinds` で受け付ける値を選びます。source-backed connector は `acceptedArtifactKinds: []` とし、resolved source view から必要な file を読みます。reference runtime-agent envelope ではその source locator を `LifecycleApplyRequest.preparedSource` field で運びます。

例: reference `worker@v1` connector は `spec.entrypoint` を resolved source view から読みます。worker は asset descriptor を要求せず、entrypoint file は source view 内に置きます。

per-metadata size cap、 registered metadata、 discovery API は [asset Policy](./data-asset-policy.md#accepted-kind-policy) を参照。

asset は optional operator extension の概念名です。`acceptedArtifactKinds` や `artifact_kind_mismatch` のような `artifact*` wire names は compatibility 名です。

dry-run / apply resolution の強制:

- asset-backed request の operator asset metadata value が `acceptedArtifactKinds` に含まれない場合、`artifact_kind_mismatch` error で reject される。
- reference asset extension は `registerArtifactKind` で discovery metadata を登録する。別の operator implementation は別の discovery registry を使えるが、 connector 向け resolver は dispatch 前に accepted metadata set を確認する。

source-backed connector の input contract は connector-specific `spec` と resolved source locator で決まる。`spec` は public Source object を開いたまま渡す場所ではなく、operator-selected adapter が source artifact、binding snapshot、operator policy から作った closed lifecycle input です。implementation binding / connector binding のマッチングは resolver を通る。

## Space 可視性 {#space-visibility}

Connector は user / Source から addressing できない。可視性は operator policy が制御し、Space ごとに resolve される。

- `spaceVisibility: operator-policy-driven` (デフォルト): service は resolve 時に operator policy を参照し、どの Space がこの Connector を見えるかを決定する。親子関係を含む異なる Space は異なる Connector set を見うる。
- `spaceVisibility: <closed Space-set descriptor>`: Connector は descriptor に一致する Space にのみ可視である。operator 定義の Space-set descriptor は policy metadata であり、public PlatformService binding selection とは別物である。

Resolver の挙動:

- active Space に不可視な Connector だけを選択する connector resolution は、runtime-agent dispatch 前に closed plan error で失敗する。
- reference resolver は Space に可視な Connector set を replay 用の retained evidence として記録する。異なる visibility state に対する replay は決定的な divergence を surface する。
- visibility の変更は既存の retained evidence を変更しない。次回 deploy 時に新しい resolution record として surface する。

operator はアドホックな Space 設定ではなく policy から visibility を駆動することが期待される。これにより Space レベル policy が監査可能になり、 resolver も決定的に保たれる。

## Reference envelope versioning {#envelope-versioning}

Connector は runtime-agent との間で control envelope を喋る。 envelope は service HTTP API とは独立にバージョンが付く。

- `v1` はこの release line の reference runtime-agent envelope version である。
- breaking な envelope 変更は connector guide、runtime-agent dispatch、docs、 tests を同時に更新する。
- 複数の envelope version をサポートする distribution は、そのサポートを Connector registry に明示的に記録する。

v1 の apply / destroy envelope では、Takosumi service の internal WAL dispatch path から来る runtime-agent request が WAL 由来の `idempotencyKey` を運ぶ。 Installer API には user-supplied `Idempotency-Key` header はありません。同じ operation tuple は `operationRequest` と `metadata.takosumiOperation` (`phase`、 `walStage`、 `operationId`、 `resourceName`、 `providerId`、 `operationPlanDigest`、 raw tuple) からも得られる。 Connector は同じキーでの繰り返し呼び出しを同一の論理 side effect として扱い、 request-token semantics を公開するクラウド API にキーを forward しなければならない。

envelope version は Connector record の一部です。Connector は envelope upgrade を跨いで `connector:<id>` を保つ。 upgrade path は `replace` operation で、以前と新規の envelope version の両方を記録する。

## Reference registry operator operations {#operator-only-operations}

次の Connector operation は current reference connector registry の operator surface に予約されている。Source repository や Installer API caller から address できず、public CLI deploy path にも公開されない。別 implementation は別の inventory / lifecycle 管理方式を使えます。

- `install`: 新しい `connector:<id>` を初期 record とともに登録する。audit log に `connector-registered` として記録される。
- `replace`: 既存の `connector:<id>` に新しい Connector record を bind する。 audit log に `connector-replaced` として記録される。削除される metadata value に依存する binding が存在する場合、operator が明示的な drain plan を渡さない限り `acceptedArtifactKinds` の縮小は reject される。
- `revoke`: active registry から `connector:<id>` を削除する。audit log に `connector-revoked` として記録される。revoke された Connector を参照する既存の TrafficSnapshot は replay 可能なまま残り、revoke された identity を対象とする新規 resolution は失敗する。

operator 専用 operation は Installer bearer や asset writer token ではなく operator bearer で gate される。 runtime-agent はユーザーに代わってこれらの operation を実行しない。

## Reference service adapter からの利用 {#implementation-adapter-consumption}

Reference service adapter は Connector の下流 consumer (= service 側の implementation adapter) です。Source author は Connector を直接選ばず、 operator distribution の resolution が implementation binding / Connector binding を選びます。

- reference adapter は依存する `connector:<id>` identity を宣言する。current reference resolver は apply 時に各宣言済み identity を確認し、宣言された Connector が active Space に不可視であれば apply を reject する。
- reference adapter は resolved Connector record (`id`、connector-local selector field、`acceptedArtifactKinds`、`envelopeVersion`) を受け取るが、 Connector の credential は受け取らない。credential は runtime-agent host または operator implementation が選択した別の service-external execution host に留まる。
- reference adapter は新しい `connector:<id>` identity を作成してはならない。新しい Connector が必要な adapter は operator の `install` operation を通じて要求する。

service-side implementation adapter の record schema と registration API は [Kind Binding Implementations](./kind-bindings.md) を参照。

## Runtime-Agent ホスティング {#runtime-agent-hosting}

runtime-agent は Connector を in-process モジュールとして host する。

- 各 Connector は runtime-agent の起動ごとに 1 回ロードされる。connector-local selector と `acceptedArtifactKinds` は `GET /v1/connectors` で公開される。
- runtime-agent は lifecycle 呼び出し (`apply`、`destroy`、`describe`、`verify`) を connector-local selector で Connector module に dispatch する。 `connector:<id>` は operator inventory identity のまま残る。
- Connector code は service host に到達しない。service は lifecycle envelope を通じて runtime-agent を呼び、runtime-agent が Connector module を呼ぶ。
- source-backed connector は lifecycle envelope に含まれる resolved source view から読む。asset-backed connector は `TAKOSUMI_ARTIFACT_FETCH_TOKEN` を使って operator asset extension 経由で bytes を取得できる。

lifecycle envelope の wire format と error code enum は [Reference Runtime-Agent Execution Surface](./runtime-agent-api.md) を参照。

## 関連アーキテクチャ {#related-architecture-notes}

- `reference/data-asset-policy` — asset metadata policy と accepted metadata vector。
- `reference/architecture/operator-boundaries` — operator がインストールした Connector と Space visibility。
- `reference/architecture/operator-boundaries` — Connector credential を runtime-agent host に留める trust 分離。
- `reference/architecture/operator-boundaries` — Connector を消費する reference adapter の authoring パターン。

## 関連ページ

- [asset Policy](./data-asset-policy.md)
- [Kind Binding Implementations](./kind-bindings.md)
- [Reference Runtime-Agent Execution Surface](./runtime-agent-api.md)
- [Audit Events](./audit-events.md)
