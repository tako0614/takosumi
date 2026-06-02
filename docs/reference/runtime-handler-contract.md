# Reference Runtime-Agent Handler Guide {#runtime-handler-contract}

このページは reference implementation のガイダンスであり、Takosumi の public Installer contract ではありません。互換 installer は Runtime handler lifecycle operation を公開したり `runtime-handler:<id>` inventory format を使う必要はありません。

Reference runtime-agent path における Runtime handler は、prepared source や operator-owned asset を外部 runtime (serverless host、container orchestrator、 object storage backend など) に実体化する operator がインストールするソフトウェアユニットです。credential の共通不変条件は、cloud / OS credential を Takosumi process に置かないことです。reference runtime-agent path では credential は Runtime handler / runtime-agent host に置きますが、別 implementation は operator-owned execution host など別の service-external 場所に置けます。本リファレンスは v1 Runtime handler の identity、 runtime-agent addressing、 record schema、 source/data input、 Space visibility ルール、 envelope バージョニング、そして Runtime handler lifecycle を管理する operator 専用 operation を説明します。

## アイデンティティ {#identity}

reference runtime-agent registry における Runtime handler inventory id は以下の current compatibility format を使います:

```text
runtime-handler:<id>
```

`<id>` segment は operator が管理する inventory identity です。ユーザーが命名することはなく、Source 入力から導出されず、source repository に現れることもありません。runtime-agent lifecycle RPC の current wire field 名は `(shape, provider)` です。

operator distribution の resolver が Source、BindingSelection、PlatformService inventory、Space visibility から runtime-handler-local selector に bound された Runtime handler 実装を選びます。

Reference registry のルール:

- `runtime-handler:<id>` は operator installation 内でグローバルに一意である。
- 同じ `<id>` 値は version を跨いで異なる Runtime handler code path を指すことはない。置き換えは常に operator の `replace` operation を通り、明示的な version vector と envelope guard を伴う。
- `runtime-handler:<id>` format は reference operator registry に属する。Source repository は Runtime handler identity を作成・参照しない。
- runtime-agent の呼び出しは `(shape, provider)` で runtime handler を指定する。

## Runtime Handler Record {#runtime-handler-record}

reference runtime-agent implementation では、各 Runtime handler は operator がインストールした Runtime handler registry record で記述されます。

```yaml
Runtime handler:
  id: runtime-handler:cloudflare-workers
  shape: worker@v1
  provider: cloudflare-workers
  acceptedArtifactKinds: []
  spaceVisibility: operator-policy-driven
  envelopeVersion: v1
```

Reference registry field の意味:

- `id`: 完全な `runtime-handler:<id>` identity。
- `shape`: runtime-agent lifecycle selector。例: `worker@v1`。
- `provider`: runtime-agent provider id。例: `cloudflare-workers`。
- `acceptedArtifactKinds`: Runtime handler が受け付ける operator asset metadata value。空配列の場合、Runtime handler は source / spec を直接読む。
- `spaceVisibility`: `operator-policy-driven` (default) または Space-set descriptor。
- `envelopeVersion`: この Runtime handler が喋る control envelope version。現状は `v1`。

所与の Runtime handler インスタンスについて record は immutable である。 `acceptedArtifactKinds` を広げたい、 envelope version を変えたい operator は Runtime handler `replace` operation を実行する。reference runtime-agent path は同じ `runtime-handler:<id>` identity に bound された新規 Runtime handler record として扱う。以前の record は audit と replay 用に保持される。

## Source / Data Inputs {#source-data-inputs}

`acceptedArtifactKinds` ベクトルは、asset-backed runtime handler が consume できる operator-owned asset metadata value を列挙する current compatibility field です。ここでの `Kinds` は asset metadata value の互換 wire name であり、Takosumi Source vocabulary ではありません。asset metadata value は operator extension の registry で管理され、runtime handler が `acceptedArtifactKinds` で受け付ける値を選びます。source-backed runtime handler は `acceptedArtifactKinds: []` とし、resolved source view から必要な file を読みます。reference runtime-agent envelope ではその source locator を `LifecycleApplyRequest.preparedSource` field で運びます。

例: reference `worker@v1` runtime handler は `spec.entrypoint` を resolved source view から読みます。worker は asset descriptor を要求せず、entrypoint file は source view 内に置きます。

per-metadata size cap、 registered metadata、 discovery API は [Data Asset Policy](/reference/data-asset-policy#accepted-dataasset-metadata-policy) を参照。

asset は optional operator extension の概念名です。`acceptedArtifactKinds` や `artifact_kind_mismatch` のような `artifact*` wire names は compatibility 名です。

dry-run / apply resolution の強制:

- asset-backed request の operator asset metadata value が `acceptedArtifactKinds` に含まれない場合、`artifact_kind_mismatch` error で reject される。
- reference asset extension は `registerArtifactKind` で discovery metadata を登録する。別の operator implementation は別の discovery registry を使えるが、 runtime handler 向け resolver は dispatch 前に accepted metadata set を確認する。

source-backed runtime handler の input contract は runtime handler-specific `spec` と resolved source locator で決まる。`spec` は public Source object を開いたまま渡す場所ではなく、operator-selected adapter が source artifact、binding snapshot、operator policy から作った closed lifecycle input です。implementation binding / runtime handler binding のマッチングは resolver を通る。

## Space 可視性 {#space-visibility}

Runtime handler は user / Source から addressing できない。可視性は operator policy が制御し、Space ごとに resolve される。

- `spaceVisibility: operator-policy-driven` (デフォルト): service は resolve 時に operator policy を参照し、どの Space がこの Runtime handler を見えるかを決定する。親子関係を含む異なる Space は異なる Runtime handler set を見うる。
- `spaceVisibility: <closed Space-set descriptor>`: Runtime handler は descriptor に一致する Space にのみ可視である。operator 定義の Space-set descriptor は policy metadata であり、public PlatformService binding selection とは別物である。

Resolver の挙動:

- active Space に不可視な Runtime handler だけを選択する runtime handler resolution は、runtime-agent dispatch 前に closed plan error で失敗する。
- reference resolver は Space に可視な Runtime handler set を replay 用の retained evidence として記録する。異なる visibility state に対する replay は決定的な divergence を surface する。
- visibility の変更は既存の retained evidence を変更しない。次回 deploy 時に新しい resolution record として surface する。

operator はアドホックな Space 設定ではなく policy から visibility を駆動することが期待される。これにより Space レベル policy が監査可能になり、 resolver も決定的に保たれる。

## Reference envelope versioning {#envelope-versioning}

Runtime handler は runtime-agent との間で control envelope を喋る。 envelope は service HTTP API とは独立にバージョンが付く。

- `v1` はこの release line の reference runtime-agent envelope version である。
- breaking な envelope 変更は runtime handler guide、runtime-agent dispatch、docs、 tests を同時に更新する。
- 複数の envelope version をサポートする distribution は、そのサポートを Runtime handler registry に明示的に記録する。

v1 の apply / destroy envelope では、Takosumi service の internal WAL dispatch path から来る runtime-agent request が WAL 由来の `idempotencyKey` を運ぶ。 Installer API には user-supplied `Idempotency-Key` header はありません。同じ operation tuple は `operationRequest` と `metadata.takosumiOperation` (`phase`、 `walStage`、 `operationId`、 `resourceName`、 `providerId`、 `operationPlanDigest`、 raw tuple) からも得られる。 Runtime handler は同じキーでの繰り返し呼び出しを同一の論理 side effect として扱い、 request-token semantics を公開するクラウド API にキーを forward しなければならない。

envelope version は Runtime handler record の一部です。Runtime handler は envelope upgrade を跨いで `runtime-handler:<id>` を保つ。 upgrade path は `replace` operation で、以前と新規の envelope version の両方を記録する。

## Reference registry operator operations {#operator-only-operations}

次の Runtime handler operation は current reference runtime handler registry の operator surface に予約されている。Source repository や Installer API caller から address できず、public CLI deploy path にも公開されない。別 implementation は別の inventory / lifecycle 管理方式を使えます。

- `install`: 新しい `runtime-handler:<id>` を初期 record とともに登録する。audit log に `runtime-handler-registered` として記録される。
- `replace`: 既存の `runtime-handler:<id>` に新しい Runtime handler record を bind する。 audit log に `runtime-handler-replaced` として記録される。削除される metadata value に依存する binding が存在する場合、operator が明示的な drain plan を渡さない限り `acceptedArtifactKinds` の縮小は reject される。
- `revoke`: active registry から `runtime-handler:<id>` を削除する。audit log に `runtime-handler-revoked` として記録される。revoke された Runtime handler を参照する既存の TrafficSnapshot は replay 可能なまま残り、revoke された identity を対象とする新規 resolution は失敗する。

operator 専用 operation は Installer bearer や asset writer token ではなく operator bearer で gate される。 runtime-agent はユーザーに代わってこれらの operation を実行しない。

## Reference service adapter からの利用 {#implementation-adapter-consumption}

Reference service adapter は Runtime handler の下流 consumer (= service 側の implementation adapter) です。Source author は Runtime handler を直接選ばず、 operator distribution の resolution が implementation binding / Runtime handler binding を選びます。

- reference adapter は依存する `runtime-handler:<id>` identity を宣言する。current reference resolver は apply 時に各宣言済み identity を確認し、宣言された Runtime handler が active Space に不可視であれば apply を reject する。
- reference adapter は resolved Runtime handler record (`id`、runtime-handler-local selector field、`acceptedArtifactKinds`、`envelopeVersion`) を受け取るが、 Runtime handler の credential は受け取らない。credential は runtime-agent host または operator implementation が選択した別の service-external execution host に留まる。
- reference adapter は新しい `runtime-handler:<id>` identity を作成してはならない。新しい Runtime handler が必要な adapter は operator の `install` operation を通じて要求する。

service-side implementation adapter の record schema と registration API は [Kind Binding Implementations](./kind-bindings.md) を参照。

## Runtime-Agent ホスティング {#runtime-agent-hosting}

runtime-agent は Runtime handler を in-process モジュールとして host する。

- 各 Runtime handler は runtime-agent の起動ごとに 1 回ロードされる。runtime-handler-local selector と `acceptedArtifactKinds` は `GET /v1/runtime-handlers` で公開される。
- runtime-agent は lifecycle 呼び出し (`apply`、`destroy`、`describe`、`verify`) を runtime-handler-local selector で Runtime handler module に dispatch する。 `runtime-handler:<id>` は operator inventory identity のまま残る。
- Runtime handler code は service host に到達しない。service は lifecycle envelope を通じて runtime-agent を呼び、runtime-agent が Runtime handler module を呼ぶ。
- source-backed runtime handler は lifecycle envelope に含まれる resolved source view から読む。asset-backed runtime handler は `TAKOSUMI_ARTIFACT_FETCH_TOKEN` を使って operator asset extension 経由で bytes を取得できる。

lifecycle envelope の wire format と error code enum は [Reference Runtime-Agent Execution Surface](/reference/runtime-agent-api) を参照。

## 関連アーキテクチャ {#related-architecture-notes}

- `reference/data-asset-policy` — asset metadata policy と accepted metadata vector。
- `reference/architecture/operator-boundaries` — operator がインストールした Runtime handler と Space visibility。
- `reference/architecture/operator-boundaries` — Runtime handler credential を runtime-agent host に留める trust 分離。
- `reference/architecture/operator-boundaries` — Runtime handler を消費する reference adapter の authoring パターン。

## 関連ページ

- [Data Asset Policy](/reference/data-asset-policy)
- [Kind Binding Implementations](/reference/kind-bindings)
- [Reference Runtime-Agent Execution Surface](/reference/runtime-agent-api)
- [Audit Events](/reference/audit-events)
