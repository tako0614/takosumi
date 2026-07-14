# Model Reference

Last updated: 2026-07-14

Takosumi OSS には、2 つの公開 authoring flow と 1 つの共有 runtime interaction 層があります。
Git から plain な OpenTofu をそのまま実行する flow と、Takosumi Resource Shape を
`/v1/resources` Deploy API で解決・実行する flow です。どちらの結果も Interface として公開し、
consumer の利用は InterfaceBinding で認可します。Compatibility API は、control-plane では
Deploy API への変換、data-plane では Ready Resource の解決を行う capability 単位の surface です。

## OpenTofu Stack Concepts

| Concept            | Meaning                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| Workspace          | プロジェクト・状態・シークレット・Run・監査を分離する user/team の境界 |
| Project            | 1 つの製品・サービス・インフラのまとまり                               |
| Capsule            | 1 つの OpenTofu/Terraform module の実行単位                            |
| Source             | plain な OpenTofu/Terraform module を指す Git URL/ref/commit/path      |
| ProviderConnection | 保存された provider 認証情報の設定                                     |
| CredentialRecipe   | provider ごとの env/file/pre-run 生成レシピ                            |
| ProviderBinding    | provider 名/alias から ProviderConnection への対応付け                 |
| Secret             | 暗号化された認証情報または入力材料                                     |
| Run                | init/validate/plan/apply/destroy/refresh/output のいずれか 1 回の操作  |
| StateVersion       | Capsule に保存された state の世代                                      |
| Output             | 取得済みの OpenTofu output 値                                          |
| Runner             | local/docker/remote/operator/cloud の実行 worker                       |
| AuditEvent         | actor/action/target/result の証跡                                      |

## Resource Shape Concepts

| Concept        | Meaning                                                                |
| -------------- | ---------------------------------------------------------------------- |
| Space          | Resource API の namespace および policy scope                          |
| Environment    | Space 内の deployment 環境                                             |
| Stack          | Resource Shape object と operation のまとまり                          |
| Resource       | EdgeWorker、ObjectBucket、Queue などの、あるべきサービス形態のリソース |
| Target         | AWS、Cloudflare、Kubernetes などの具体的な実装先                       |
| TargetPool     | operator が管理する、利用可能な Target と capability の集合            |
| Credential     | Target または Adapter が使う runtime 権限                              |
| Policy         | 配置・コスト・region・action・network・access のルール                 |
| Adapter        | preview/apply/observe/delete を行う実装 bridge                         |
| ResolutionLock | Resource に対する resolver の決定を記録したもの                        |
| NativeResource | Adapter が作成した具体的な provider/platform リソース                  |
| Condition      | 状態と readiness の証跡                                                |

ここでの `Space` は Resource API の namespace および policy scope です。

## Shared Runtime Interaction Concepts

| Concept          | Meaning                                                                                                     |
| ---------------- | ----------------------------------------------------------------------------------------------------------- |
| Interface        | Workspace、Capsule、または Resource が所有する、versioned な non-secret runtime 宣言                        |
| Interface input  | `literal` / `capsule_output` / `resource_output` から得る明示的な public 値。任意で JSON Pointer を指定可能 |
| InterfaceBinding | Principal、ServiceAccount、Capsule、Resource に特定の permission と delivery 方式を与える認可               |
| Principal        | Interface を利用する human/account identity                                                                 |
| ServiceAccount   | Interface を利用する non-human identity                                                                     |

OpenTofu Output は通常の root module 戻り値のままです。Interface は、条件を満たす任意の
public な Output 名を明示的に mapping できますが、module 側が予約された Takosumi schema を
公開するわけではありません。Interface の document と解決済み input には認証情報を一切含めません。
InterfaceBinding の delivery は invocation 時点の認可であり、OpenTofu Run を認可する
ProviderBinding とは独立しています。

## OpenTofu Provider Resolution

Source と Capsule の authoring は Git のみです。登録済みの Source に対して `source_sync` が
SourceSnapshot を生成します。その変更不可な archive は runner への転送手段であり、別の source 種別や
Capsule 作成経路ではありません。

`Source.autoSync` を有効にすると、Git ref の定期 polling が動きます。ref が動くたびに新しい
変更不可な SourceSnapshot を用意します。解決された commit が、有効な Capsule が現在 apply 済みの
SourceSnapshot と異なる場合、Takosumi はその Capsule を `stale` にし、通常の Workspace update /
RunGroup 経路が確認可能な update plan を作れるようにします。それでも変更を黙って適用することは
ありません。明示的な operator policy が別途 auto-apply gate を追加しない限り、すべてのインフラ
更新は Run としての Plan / Apply を経由します。

手動更新は `manual_plan` intent の SourceSyncRun を使い、その Run が生成した
exact SourceSnapshot を plan に固定します。この intent の sync は Capsule を
`stale` にできますが、同時に別の auto-update plan/apply を開始しません。

Provider resolution には、2 つの OSS outcome に加えて policy による blocking があります。

```text
resolved_provider_connection
blocked_missing_connection
blocked_policy
```

Resolution の証跡に secret 値を含めることはありません。public API、UI、docs では
ProviderConnection と ProviderBinding を使います。

## Same Manifest, Different Connection

中核となる deployment モデルは次のとおりです。

```text
same .tf
different ProviderBinding
different ProviderConnection
```

例:

```yaml
provider_bindings:
  cloudflare.default:
    connection: cloudflare-prod
  aws.tokyo:
    connection: aws-prod-tokyo
```

Takosumi は、選択された ProviderConnection が必要とする runtime の env/file を注入します。
manifest 自体に secret を含めるべきではありません。

Operator がインストールした Credential Recipe は、設定を簡単にするための近道であって、
provider の境界そのものではありません。ユーザーが `required_providers` から provider source を
宣言し、その provider が文書化している環境変数を明示すれば、どの provider でも generic-env
ProviderConnection を使えます。宣言する env 名は `EXAMPLE_API_TOKEN` のような upper-snake の
環境変数識別子でなければならず、それらは run-local な CredentialRecipe になり、runner policy、
provider plugin policy、egress policy の対象になります。runner/runtime が予約する env 名は
拒否されます。

自分の key を使う場合、Takosumi による gate はありません。provider allowlist も operator
承認も不要です。credential さえ渡せば、どの OpenTofu/Terraform provider でも実行できます。
self-host した Takosumi は既定で wildcard runner surface を有効にし、呼び出し側が別の
operator 定義 capability profile を選ばない限り、明示的に設定された既定の RunnerProfile を
使います。provider 名や label が executor を選ぶことはありません。
自分の key で用意した ProviderConnection を Takosumi software が計測・課金することは
ありません。self-host および OSS operator の endpoint は showback usage を記録することが
ありますが、Takosumi OSS 自体に組み込みの価格はなく、operator が `ShowbackRater` を注入しない
限り測定値は zero / `unrated` のままです。これらは Takosumi Cloud の支払いを強制しません。
Takosumi Cloud が課金するのは Takosumi が提供する managed resource だけであり、その顧客向け
契約は [Takosumi Cloud pricing](https://app.takosumi.com/docs/pricing) にあります。

## Runner Policy

Runner policy、provider allowlist、lockfile/mirror ルール、resource limit、network
egress policy は、内部の control-plane safeguard です。これらは Run をどこで実行できるか、
どの provider plugin/resource に到達できるかを決めますが、ProviderConnection や
ProviderBinding のような public な製品用語ではありません。RunnerProfile の lifecycle と
availability は typed field です。その open な `executorId` は host が注入した executor
registry を通してのみ解決され、label は説明用の metadata であり、Run の有効化・予約・
スケジューリング・ルーティングを行うことはできません。Operator は provider の直接インストールを
速くするため、runner ローカルの OpenTofu provider plugin cache を設定できます。これは
provider バイナリだけを保存し、credential や生成された run ファイルは run ごとのままです。
Cloudflare Containers では、現在の runner Durable Object id は run-scoped なので、この
cache はその 1 つの runner インスタンスが生きている間だけ再利用されます。SourceSnapshot の
再利用と provider mirror が、可搬な高速化の手段です。

ユーザーから見える流れはアプリをインストールする感覚であるべきですが、モデルは Git-native /
OpenTofu-native のままです。新しいサービスの作成は、アプリを追加するのと同じ guided install
flow を使います。Git ベースの listing を選ぶか install link を入力し、必要最小限の入力だけを
設定し、plan を確認してから deploy します。Takosumi は、通常のユーザー向けに別の低レベルな
「create service」 CRUD surface を追加すべきではありません。サービス一覧は作成後に詳細を
表示できますが、追加の入口はあくまで install のような体験のままにします。

Store は discovery と presentation だけです。Store node は Git repository/path、
icon、description を告知します。setup や release の権限元ではありません。branch、tag、
commit、SourceSnapshot、update policy は Source / Run flow に留まります。Store node を
切り替えると listing と presentation metadata の読み込み元が変わるだけで、Capsule の実行
モデルは変わりません。

Repository は、表示テキスト・icon・`modulePath` を含む `.well-known/tcs.json`
presentation metadata を任意で公開できます。この文書は `git`、`source`、refs/commits、
`installConfigId`、variable presentation/defaults、`installExperience`、output
allowlist、release artifact、domain defaults、OIDC wiring、lifecycle action、
Interface blueprint を宣言してはいけません。これらは `variablePresentation`、
`installExperience`、`interfaceBlueprints` のような、top-level で DB が所有する
InstallConfig field で管理します。DB が所有する `installExperience` の `oidc_client`
projection は、public な OIDC client metadata (issuer、client id、redirect URI) に
加えて必要な OAuth scope を宣言できます。`openid` は必須で、scope は重複のない
non-empty token に限ります。client secret、access token、refresh token を
repository metadata、OpenTofu 変数、state、Output に投影することはありません。

DB が所有する `interfaceBlueprints` の各 entry は、明示的で不変な `key` を必須とします。
Takosumi は、編集可能な表示用 `name` を materialization identity の代わりに使うことは
ありません。

Git source sync は、選択された OpenTofu module archive とは別に、この
repository-root document の bounded observation を変更不可な `SourceSnapshot`
に記録します。この observation は表示用の証跡に過ぎず、欠落や無効さが snapshot の再利用や
Store-backed planning を止めることはなく、保存済みの InstallConfig を書き換えることも
ありません。

Takosumi は SourceSnapshot、provider mirror、provider plugin cache、runner
capacity control、package cache、明確な進行 phase を再利用できます。既定の高速経路は、
repository の OpenTofu module が消費し SHA-256 で検証する Git CI/release artifact です。
Capsule は代わりに、明示的な argv コマンドと期待される相対 output を持つ `sourceBuild` を
選ぶこともできます。この phase には provider credential が渡されず、インフラの選択や作成も
できません。OpenTofu plan の所有者は引き続き Git module です。

`sourceBuild` は service-side の Capsule 設定であり、Store metadata ではなく、
`.well-known/tcs.json` の実行可能な field でもありません。Takosumi は `package.json` から
コマンドを推測せず、release artifact が見つからない場合に黙って build へ fallback すること
もありません。コストの高い OCI/container image の build は、app repository の CI と
registry 側に留めるべきです。

Release/update の自動化は Git-native です。Source は branch、tag、commit ref のいずれかを
追跡し、source sync がその ref を変更不可な commit と archive に解決します。より古い commit
で稼働している Capsule は `stale` になり、Workspace update がその変更を plan します。module が
事前 build 済みの container/image/bundle を使う場合は、通常の OpenTofu 変数、provider、
data source を通して行います。明示的な source build は、plan/apply/destroy の
materialization のたびに、同じ pinned snapshot に対して実行されます。

reference runner は、成功した plan の container を `TAKOSUMI_RUNNER_KEEPALIVE_SECONDS`
秒だけ温めた状態で保持し (既定 `0`。公式 Cloud は、warm な間に apply / destroy apply が
plan runner object へ戻れるよう `120` を使います)、plan 以外の run は成功後に、失敗した run は
すべて即座にシャットダウンします。Operator は非 secret な速度設定として
`TAKOSUMI_OPENTOFU_PLUGIN_CACHE_DIR`、`TAKOSUMI_SOURCE_BUILD_CACHE_DIR`、
`TAKOSUMI_SOURCE_ARCHIVE_ZSTD_LEVEL`、runner capacity の retry 設定も渡せます。これは
run をまたぐ source-sync cache ではありません。

## Resource Shape Resolution

Resource Shape flow は typed な Resource object から始まり、それを Target へ解決します。
これらの object は `/v1/resources` Deploy API、`takosumi_*` provider resources、CLI、dashboard、
Kubernetes CRD のいずれからでも送信できます。

```text
Resource Shape
  -> TargetPool / Policy / Credential
  -> Adapter capability
  -> ResolutionLock
  -> NativeResource
```

ユーザーは通常、backend ではなく欲しい shape を記述します。どの Target が利用可能か、
どの Adapter が有効か、どの policy が配置を制御するかは operator が決めます。Resolver の
決定は ResolutionLock として記録され、明示的な migration なしに動くことはありません。
TargetPool / Policy / Adapter は operator/advanced surface で、通常 UX は service form、
必須入力、価格、preview、deploy に絞ります。

Resource Shape は、外部インフラ向けの既存 provider を置き換えるものではありません。
外部 resource に十分な provider/API がある場合は plain Stack flow で使います。一方、
Takosumi/operator が managed capacity として販売・運用するサービスは、標準 protocol の
有無にかかわらず provider-neutral な Resource Shape として定義します。標準/compat surface
はその Resource の control-plane translation または data-plane であり、lifecycle authority
ではありません。

`/v1/resources` は preview/apply/observe/refresh/import/delete と canonical Resource、
ResolutionLock、NativeResource、Run、status、Output、audit の唯一の正本です。TargetPool、
Policy、Adapter、backend manager はこの API の背後にある operator/advanced machinery です。

標準 surface が存在しないだけでは、Takosumi が自動的に catch-all な provider を
作る理由になりません。一回限りの不足や外部インフラは generic-env
ProviderConnection と通常の OpenTofu module に留めるべきです。新しい `takosumi_*`
resource が正当化されるのは、operator が managed capacity として提供し、typed schema、
planner、adapter、import/drift/state の挙動、capability 証跡を必要とする、繰り返し現れる
provider-neutral なサービス形態だけです。
Takosumi 所有のサービス形態にも operator/admin object にも対応しない provider resource は、
存在する理由がありません。

`takosumi/takosumi` provider は任意の typed Deploy API client です。shape、service offering、
価格、backend selection、lifecycle state の正本ではないため、direct API、CLI、dashboard、
compatibility client から同じ managed service を利用できます。

Takos は、この rule の代表的な consumer です。Takos は、製品固有の catch-all shape
としてではなく、実際に必要な汎用 Resource Shape の合成として説明するべきです。

```text
Takos distribution:
  EdgeWorker        -> takos-worker
  SQLDatabase       -> workspace/control database
  KVStore           -> session/cache/state binding
  ObjectBucket      -> files and workspace objects
  Queue             -> agent jobs and product events
  ContainerService  -> takos-agent container
```

別途 install する `takos-git` Capsule は自身の generic service topology を持ち、
Interface / InterfaceBinding 経由で Takos が利用します。

`takosumi_takos` やそれに相当する one-resource wrapper は追加しません。もし Takos が
後になって、これらの汎用 shape で表現できないサービス形態を必要とする場合は、同じ prior-art
gate を通過してから、その不足しているサービス形態だけを追加します。

`EdgeWorker` や `ContainerService` のような消費側 shape は、利用する shape への
non-secret な `connections` を宣言できます。connection が運ぶのは resource reference、
requested permissions、projection kind だけです。credential material と具体的な
runtime binding の生成は、Credential / ProviderConnection と adapter の実行側に
留まります。HCL の surface は `connections = [...]` です。`connection` は
OpenTofu/Terraform の予約語です。

Adapter は capability を報告し、preview/apply/import/observe/refresh/delete の
作業を行います。初期の adapter family には OpenTofu、Cloudflare、AWS、Kubernetes、VM、
Takosumi-native adapter を含められます。

platform scheduler は、現 generation の `Ready` Resource に対して、この同じ read-only な
`observe` operation を再利用します。bounded な durable lease が isolate 間の重複観測を防ぎ、
scheduler が refresh、apply、ResolutionLock の変更、別の Resource registry の作成を行う
ことはありません。1 つの backend 障害は、残りの対象 Resource から分離されます。

拡張可能な surface は capability token を使います。例えば `ContainerService`
target は、custom な interface 証跡を持つ operator 定義の implementation plugin を
公開できます。endpoint はこれらの token を、ハードコードされた provider binary
allow-list ではなく resolver/policy を通して受理・拒否します。この拡張は既存の typed
shape の backend 向けです。新しい HCL 向けの `takosumi_*` shape を追加するには、
OpenTofu が typed validation、plan diff、import、state upgrade の挙動を維持できるよう、
引き続き schema/API/provider の release が必要です。

Provider capability document は、`adapters` 配下の追加 boolean key として
operator 定義の adapter token を含められます。既知の adapter key は引き続き `opentofu`、
`aws`、`cloudflare`、`kubernetes`、`vm`、`takosumi_native` です。追加の key は
endpoint 固有であり、TargetPool の証跡と plugin 対応の adapter に裏付けられている
必要があります。

Secret は引き続き Credential/ProviderConnection の材料であり、Resource Shape の
spec や OpenTofu state に置かれることはありません。AI Gateway の設定も同じ secret/env
projection のルールに従い、既定の Resource Shape ではありません。

## Compatibility Capabilities

Compatibility API は scope と version が明示された入口です。次のように
capability として有効化・広告されます。

```text
compat.s3.v1
compat.oci.v1
compat.cloudevents.v1
compat.kubernetes.crd.v1
compat.cloudflare.workers.v1
```

これらは、Takosumi が backend、import path、managed-target の制御を提供する
場合に、狭い範囲の標準 facade を維持します。AWS 完全互換、Cloudflare API 完全互換、
内部の provider 固有モデルを名乗るものではなく、既存 provider ですでに動く標準を
作り直す理由にもなりません。

control-plane compatibility profile は request を typed Resource desired state へ変換して
Deploy API を呼び、独自の lifecycle row や backend dispatch を持ちません。data-plane
profile は Ready な canonical Resource と認可済み Interface / NativeResource evidence を
解決します。対応していない操作は完全互換を装わず fail closed します。

public API の境界は [Takosumi API](./api.md) に文書化されています。内部の
planning と conformance に関するメモは、公開 docs surface の外にあります。

## Operator / Cloud Concepts

以下は運用・hosted service の概念であり、可搬な OSS モデルの要件ではありません。

```text
commercial customer management
subscription / invoice / payment integration
official managed target pools
official native runtime / object store / queue / DB / edge gateway internals
official billing / SLA / support / abuse controls
```

Takosumi for Operator は、自身の managed target catalog と商用 service を
運用できます。Takosumi Cloud は、公式の managed capacity を持つ公式の hosted 運用です。

Cloud の sellable model は versioned `ServiceOffering` と `PriceCatalog` です。preview は
Resource desired-state digest、resolution fingerprint、offering/catalog version、SKU line
items、currency、estimated total、expiry、quote digest を固定した `DeploymentQuote` を返します。
billable apply は quote id/digest を必須とし、backend 作業前に reserve、成功時に capture、
失敗・cancel 時に release します。captured reservation と rated UsageEvent は payment-provider
invoice line と照合します。これらは Resource lifecycle を囲む Cloud の商用 record であり、
retire 済み `Deployment` ledger を戻すものではありません。
