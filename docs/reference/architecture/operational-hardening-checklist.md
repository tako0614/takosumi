# 運用 Hardening チェックリスト {#operational-hardening-checklist}

このページは未完タスク表ではなく、reference / operator production profile が満たすべき hardening requirements の一覧です。各 requirement の実装状況は対応する reference docs / tests / release evidence で確認します。

Public concept は `Source` / `Installation` / `Deployment` / `PlatformService` に閉じる。このページで出る `ResolvedPlan`、
`TargetState`、`PlatformServiceDeclaration`、`PlatformServiceMaterialization`、生成 object、journal、evidence は
reference implementation の内部 evidence / runtime primitive であり、Source authoring vocabulary や public contract ではない。
provider infrastructure の materialization workflow は operator distribution が所有し、Takosumi は PlatformService inventory を
consume して binding snapshot / evidence を Deployment に記録する。

## Space 隔離 {#space-isolation}

- すべての Deployment、snapshot、journal、observation、approval、debt、activation、 RoutingPointer は Space id を持つ。
- Space は deploy context / auth / API / operator distribution から決まる。
- platform service path は Space scope である。
- secret、optional asset、journal、approval、observation、audit event は Space scope である。
- service root は operator または product distribution が定義し、具体的な platform service path は operator policy によって Space 内に可視化される。
- RoutingPointer の identity は `spaceId + groupId` である。

## Root 不変条件 {#root-invariants}

- ResolvedPlan と TargetState は immutable である。
- apply は resource effect 実行中に catalog document や platform service registry を再解決せず、記録済みの resolution evidence と snapshot を使う。
- すべての graph entity は安定したアドレスを持つ。
- lifecycle class は operation 種別を制限する。
- core canonical state は raw secret 値ではなく secret reference を保存する。
- actual effect は pause / compensation / approval なしに approved effect を超えてはならない。
- side effect を持つ operation は write-ahead journal される。
- reference-internal 生成 object / evidence record の id は可能な限り決定的である。
- apply と activation は分離される。
- observation は事実を追記する。desired state の変更は新しい snapshot を通じて行う。
- Deployment destroy は lifecycle policy に従い、Takosumi が記録した projection / binding evidence と operator policy による cleanup authority の範囲で処理する。
- 本番は critical mutation、future cross-Space service sharing policy、descriptor / implementation binding set 更新を直列化する。

## Source / install plan resolution {#component-kind-resolution}

- Source input は Git / prepared / local source identity と generic repo metadata に閉じる。
- InstallPlan は dry-run response snapshot であり、authoring DSL や永続 public entity ではない。
- apply は dry-run で確認した `planSnapshotDigest` guard と source identity を検証する。
- PlatformService selection / implementation binding は operator-owned PlatformService inventory から解決し、未解決の場合は fail-closed する。
- catalog entry、kind 固有の input schema、binding は runtime 使用前に reference-internal evidence として解決・記録される。

Reference / operator production の設定:

- 実行ターゲットは operator が選択した binding set から決まる。
- runtime-agent や backend inventory の drift は operator / Deployment evidence として記録され、Source authoring vocabulary としては扱わない。
- provider resource creation、Terraform/OpenTofu/Helm/Pulumi apply、credential provisioning は operator distribution の materialization workflow であり、Takosumi core の public concept ではない。

## Platform service {#platform-services}

- platform service path の grammar は各 Space 内で強制される。
- shadowing は policy で gate され、本番では meaningful な Space / operator / external shadowing をデフォルトで拒否する。
- デフォルトの platform service entry は admin access を暗示しない。
- credential や authorization の出力データを生成する output slot は、safe default が宣言されない限り明示的な access を要求する。
- `PlatformServiceDeclaration` と `PlatformServiceMaterialization` は reference-internal evidence object として分離される。public concept は Space-visible `PlatformService` と Deployment の `bindingsSnapshot` である。

## Journal と回復 {#journal-and-recovery}

- operation intent は外部呼び出しの前に記録される。
- reference-internal 生成 object / evidence record の planned record は生成前に書き込まれる。
- 外部呼び出しの開始と observed handle は両方 journal される。
- cleanup の失敗時に CleanupBacklog が作成される。
- 未解決の debt を持つ journal entry は compaction で消されない。

## Policy と approval {#policy-and-approval}

- approval は snapshot digest、operation plan digest、effect details に bind される。
- approval invalidation trigger は [承認モデル](./approval-model.md) の closed v1 set に従って実装される。
- plan risk は安定した risk id を持ち、closed v1 Risk enum から引かれた kind のみを emit する。
- error hint は safeFix、requiresPolicyReview、operatorFix に分類される。

## シークレット {#secrets}

- secret を含む output slot / reference-internal PlatformService materialization evidence は plain env に project できない。
- literal env secret scanning または policy が有効である。
- runtime secret はデフォルトで transform に渡されない。

## Activation {#activation}

- ingress reservation と traffic assignment は分離される。
- RoutingPointer 更新は Space ごとに直列化される。
- rollback mode は明示的である。

## Observability {#observability}

- audit event は kind schema selection、resolution、desired adoption、link selection、operation stage、reference-internal 生成 object / evidence、debt、approval、activation、 RoutingPointer を含む。
- CleanupBacklog は operator status view と deploy gate で可視である。`/readyz` は Takosumi control-plane readiness のみに留まる。
