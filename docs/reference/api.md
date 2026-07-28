# Takosumi API

Takosumi API は、OpenTofu control plane と Resource Shape API を公開します。control
plane は Git を正とする情報源 (source of truth) として動きます。Workspace / Capsule /
Run などの用語は [用語集](./glossary.md) を参照してください。

外部インフラには既存 provider と標準 API を使います。Takosumi が managed capacity
として提供するサービスは、provider-neutral な Resource Shape で定義します。その
lifecycle は `/v1/resources` の Deploy API が一元管理します。

## 基本方針

| 状況 | 扱い方 |
| --- | --- |
| 外部 resource に標準 API / OpenTofu provider がある | plain Stack flow でその surface を使う |
| Takosumi/operator が managed service を提供する | provider-neutral な Takosumi Resource Shape として定義し、Deploy API で管理する |
| 一回限りの不足 | generic-env ProviderConnection と通常の OpenTofu module で扱う |

Takosumi は自前の Terraform / OpenTofu provider を配布しません。portable Form は
Takoform、operator 操作はこの API・CLI・dashboard を使います。外部 provider は
plain Stack flow でそのまま実行され、Resource の canonical lifecycle は Takosumi
endpoint が Resolver / Adapter / TargetPool / Policy に基づいて管理します。
Cloudflare 固有の import/deploy compatibility profile は廃止済みです。

## エンドポイントの探索

すべての Takosumi endpoint は、次の discovery endpoint を公開します。

```http
GET /.well-known/takosumi
GET /v1/capabilities
```

CLI、dashboard、Takoform client とその他の API client は、edition 名ではなく
capability を参照します。

例を示します。

```json
{
  "product": "takosumi",
  "api_versions": ["takosumi.dev/v1alpha1"],
  "features": {
    "stacks": true,
    "resource_shapes": true,
    "opentofu_runner": true,
    "oidc": true,
    "workload_identity": true,
    "compat_framework": true,
    "compatibility_profiles": ["compat.takoform.v1"],
    "interfaces": true
  },
  "endpoints": {
    "api": "https://takosumi.example.com/api",
    "capabilities": "https://takosumi.example.com/v1/capabilities",
    "oidc_issuer": "https://takosumi.example.com"
  }
}
```

field 名は snake_case です。`product` は常に `takosumi` で、client は最初にこれを
確認します。`endpoints.api` は origin そのものではなく `<origin>/api` です。

`features.compatibility_profiles` は文字列の配列です。その endpoint の operator が
実際に有効化した互換プロファイルの token だけが並びます。既定値はなく、何も
設定していない endpoint では空配列です。mobile client 用の OIDC client id を
設定した endpoint は `oidcClientId` も返します。追加の endpoint family を公開する
endpoint は `endpoints.extensions` を併せて返します。

## 共通のオブジェクト形式

Resource Shape API の object は、Kubernetes 風の形式に揃えています。

```json
{
  "apiVersion": "takosumi.dev/v1alpha1",
  "kind": "EdgeWorker",
  "metadata": {
    "name": "api",
    "space": "prod",
    "managedBy": "opentofu",
    "labels": {
      "app": "example"
    }
  },
  "spec": {
    "name": "api",
    "source": {
      "artifactPath": "dist/worker.js"
    },
    "profiles": ["workers_bindings"]
  },
  "status": {
    "phase": "Ready",
    "observedGeneration": 3,
    "conditions": [
      {
        "type": "Ready",
        "status": "true"
      }
    ]
  }
}
```

`spec` はあるべき状態 (desired state)、`status` は Takosumi が観測した状態です。
secret の値は `spec`、`status`、OpenTofu state、ログ、監査記録のいずれにも保存しません。

## 認証

API client は endpoint の設定に応じて session cookie または bearer token を使います。

```http
Authorization: Bearer <token>
```

どの Takosumi endpoint も、operator が有効化した session / bearer token 方式を
capability として公開します。Takosumi Cloud の API key は、Takosumi Accounts の
personal access token です。S3-compatible endpoint のように標準 protocol 自体が
署名方式を持つ場合は、その protocol の署名を使います。

## OpenTofu Stack API

Stack API は plain OpenTofu / Terraform module を Git から実行します。
この flow では既存 provider をそのまま使います。

stock composition は、すべての正しい provider source に provider-neutral な
`opentofu-default` 実行経路を使います。operator は別の capability profile を明示
選択できます。Credential Recipe は env/file の設定を簡単にする補助情報です。Recipe が
ない provider も、generic な env/file の ProviderConnection を作れば実行できます。

`providerConfig` と `moduleInputDefaults` は非 secret の metadata です。endpoint、
region、通常の module default をここに書きます。credential らしい field は拒否されます。
token / password / private key などは、ProviderConnection の write-only な
`values` / `files` に保存します。Run では Credential Recipe を経由して一時注入します。

provider cache / mirror があれば `tofu init` はそれを利用し、なければ通常の
OpenTofu registry 経路を利用します。mirror を必須にする場合は operator policy
として明示します。

Stack flow のエンドポイントはすべて `/api/v1` の下にあります。`/v1` は別物で、
後述の Resource / Interface 制御面です。この 2 つを取り違えると認証は通っても
404 になります。

正本は `accounts/service/src/control-route-inventory.ts` で、公開されているのは
次の 74 件です。

**Workspace**

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/v1/workspaces` | 自分が参加している Workspace を一覧する |
| POST | `/api/v1/workspaces` | Workspace を作る |
| GET | `/api/v1/workspaces/{workspaceId}` | Workspace を読む |
| PATCH | `/api/v1/workspaces/{workspaceId}` | Workspace を更新する |
| GET | `/api/v1/workspaces/{workspaceId}/members` | メンバーを一覧する |
| POST | `/api/v1/workspaces/{workspaceId}/members` | メンバーを追加する |
| PATCH | `/api/v1/workspaces/{workspaceId}/members/{subject}` | メンバーの役割を変える |
| DELETE | `/api/v1/workspaces/{workspaceId}/members/{subject}` | メンバーを外す |
| GET | `/api/v1/workspaces/{workspaceId}/graph` | Capsule の依存グラフを読む |
| GET | `/api/v1/workspaces/{workspaceId}/activity` | 操作履歴を一覧する |
| GET | `/api/v1/workspaces/{workspaceId}/usage` | 利用量を一覧する |
| GET | `/api/v1/workspaces/{workspaceId}/billing` | 課金状態を読む |
| GET | `/api/v1/workspaces/{workspaceId}/backups` | 制御情報の書き出しを一覧する |
| POST | `/api/v1/workspaces/{workspaceId}/backups` | 制御情報を書き出す |
| POST | `/api/v1/workspaces/{workspaceId}/plan-update` | Workspace 全体の更新 Run を作る |
| POST | `/api/v1/workspaces/{workspaceId}/drift-check` | Workspace 全体の差分確認 Run を作る |

操作履歴は `/api/v1/workspaces/{workspaceId}/activity` から読みます。

**Project と Capsule**

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/v1/workspaces/{workspaceId}/projects` | Project を一覧する |
| POST | `/api/v1/workspaces/{workspaceId}/projects` | Project を作る |
| GET | `/api/v1/projects/{projectId}` | Project を読む |
| GET | `/api/v1/workspaces/{workspaceId}/capsules` | Capsule を一覧する |
| POST | `/api/v1/workspaces/{workspaceId}/capsules` | Capsule を作る |
| GET | `/api/v1/capsules/{capsuleId}` | Capsule を読む |
| PATCH | `/api/v1/capsules/{capsuleId}` | Capsule を更新する |
| DELETE | `/api/v1/capsules/{capsuleId}` | 破棄計画を作る |
| GET | `/api/v1/capsules/{capsuleId}/outputs` | 公開 Output を読む |
| GET | `/api/v1/capsules/{capsuleId}/usage-summary` | 利用量の集計を読む |
| GET | `/api/v1/capsules/{capsuleId}/state-versions` | StateVersion を一覧する |
| GET | `/api/v1/capsules/{capsuleId}/dependencies` | 依存を一覧する |
| POST | `/api/v1/capsules/{capsuleId}/dependencies` | 依存を作る |
| DELETE | `/api/v1/dependencies/{dependencyId}` | 依存を削除する |
| GET | `/api/v1/capsules/{capsuleId}/provider-bindings` | ProviderBinding の選択を読む |
| PUT | `/api/v1/capsules/{capsuleId}/provider-bindings` | ProviderBinding の選択を置き換える |
| GET | `/api/v1/workspaces/{workspaceId}/current-state-versions` | 現在の StateVersion をまとめて読む |
| GET | `/api/v1/capsule-configs` | Capsule 作成設定を一覧する |
| GET | `/api/v1/capsule-configs/{capsuleConfigId}` | Capsule 作成設定を読む |
| PATCH | `/api/v1/capsule-configs/{capsuleConfigId}` | Capsule 作成設定を更新する |

Capsule を作ってから実行するには、まず計画を作り、内容を確認してから適用します。
Run は必ず計画の作成から始まります。

| メソッド | パス | 説明 |
| --- | --- | --- |
| POST | `/api/v1/capsules/{capsuleId}/plan` | 計画 Run を作る |
| POST | `/api/v1/capsules/{capsuleId}/destroy-plan` | 破棄計画 Run を作る |
| POST | `/api/v1/capsules/{capsuleId}/drift-check` | 差分確認 Run を作る |
| POST | `/api/v1/capsules/{capsuleId}/backups` | Capsule のバックアップを作る |

**Source**

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/v1/sources` | Source を一覧する |
| POST | `/api/v1/sources` | Source を作る |
| GET | `/api/v1/sources/{sourceId}` | Source を読む |
| PATCH | `/api/v1/sources/{sourceId}` | Source のメタ情報を更新する |
| POST | `/api/v1/sources/{sourceId}/sync` | 同期 Run を作る |
| GET | `/api/v1/sources/{sourceId}/snapshots` | SourceSnapshot を一覧する |
| POST | `/api/v1/sources/{sourceId}/compatibility-check` | 互換性レポートを作る |
| GET | `/api/v1/compatibility-reports/{reportId}` | 互換性レポートを読む |

**Run と StateVersion**

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/v1/workspaces/{workspaceId}/runs` | Run を一覧する |
| GET | `/api/v1/runs/{runId}` | Run を読む |
| POST | `/api/v1/runs/{runId}/approve` | Run を承認する |
| POST | `/api/v1/runs/{runId}/apply` | 確認済みの Run を適用する |
| POST | `/api/v1/runs/{runId}/cancel` | Run を取り消す |
| GET | `/api/v1/runs/{runId}/logs` | Run のログを読む |
| GET | `/api/v1/runs/{runId}/events` | Run のイベントを読む |
| GET | `/api/v1/runs/{runId}/cost` | Run の費用見込みを読む |
| GET | `/api/v1/run-groups/{runGroupId}` | まとめて実行した Run を読む |
| POST | `/api/v1/run-groups/{runGroupId}/approve` | まとめて実行した Run を承認する |
| GET | `/api/v1/state-versions/{stateVersionId}` | StateVersion を読む |
| POST | `/api/v1/state-versions/{stateVersionId}/rollback-plan` | 以前の状態に戻す計画を作る |

**認証情報と Output の共有**

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/v1/connections` | Connection を一覧する |
| POST | `/api/v1/connections` | 書き込み専用の Connection を作る |
| POST | `/api/v1/connections/{connectionId}/test` | Connection を検証する |
| POST | `/api/v1/connections/{connectionId}/revoke` | Connection を失効させる |
| POST | `/api/v1/connections/oauth/{helperId}/start` | OAuth 補助を開始する |
| GET | `/api/v1/connections/oauth/{helperId}/callback` | OAuth 補助を完了する |
| GET | `/api/v1/provider-connections` | Workspace から見える ProviderConnection を一覧する |
| GET | `/api/v1/credential-recipes` | Credential Recipe を一覧する |
| GET | `/api/v1/output-shares` | OutputShare を一覧する |
| POST | `/api/v1/output-shares` | OutputShare を作る |
| POST | `/api/v1/output-shares/{shareId}/approve` | OutputShare を承認する |
| POST | `/api/v1/output-shares/{shareId}/revoke` | OutputShare を失効させる |

Connection の作成は `POST /api/v1/connections` です。`/api/v1/provider-connections`
は読み取り専用で、失効は `POST /api/v1/connections/{connectionId}/revoke` です。

**dashboard 用の投影**

| メソッド | パス | 説明 |
| --- | --- | --- |
| GET | `/api/v1/dashboard/bootstrap` | 画面の初期表示に必要な情報をまとめて読む |
| GET | `/api/v1/dashboard/overview` | Workspace の概況を読む |

Operator が用意した組み込みの設定補助 (credential recipe) は、次の session API から
確認できます。

```http
GET /api/v1/credential-recipes
```

Run は Capsule への操作を 1 種類の記録エントリにまとめたものです。`type` は
`source_sync` / `compatibility_check` / `plan` / `apply` / `destroy_plan` /
`destroy_apply` / `drift_check` / `backup` / `restore` のいずれかになります。

Git checkout からビルドする Capsule は、作成時に任意の `sourceBuild` を指定できます。
これはユーザーが明示的に承認する Capsule 設定です。

```json
{
  "sourceBuild": {
    "commands": [
      { "argv": ["bun", "install", "--frozen-lockfile"] },
      { "argv": ["bun", "run", "build"], "workingDirectory": "web" }
    ],
    "outputs": ["web/dist/index.js"]
  }
}
```

command は shell 文字列ではなく argv 配列です。working directory と output は
Git checkout 内の相対 path に限り、provider credential は build phase に渡しません。
指定しない場合は通常どおり、OpenTofu module が成果物を解決します。参照元は
release artifact の URL / digest、provider、data source などです。

repository の `public_endpoint` projection が managed hostname を使う場合、Capsule
作成時に割り当て方を選べます。省略時は `scoped` です。この値は、同じ `subdomain` /
`url` / `routePattern` 変数を確定するための control-plane policy です。

```json
{
  "managedPublicHostname": { "mode": "vanity" }
}
```

`scoped` は `<workspace-handle>-<label>.<managed-base-domain>` で枠を消費しません。
`vanity` は `<label>.<managed-base-domain>` をそのまま使い、Workspace の変更不可な
owner account の有限枠を 1 つ消費します。どちらも hostname 単位で
first-come-first-served に予約します。

managed hostname reservation と vanity slot は Capsule lifetime に属します。成功した
Capsule destroy で解放し、個別 route の削除では解放しません。ユーザー所有 custom
domain は、この mode ではなく別の verified-domain lifecycle を使います。Takosumi Cloud
では verification / certificate lifecycle が未実装のため Planned です。Cloud managed
route への要求は安全側に停止します。通常の OpenTofu の URL / route 変数を
BYOC provider へ渡す経路は、これとは別にそのまま使えます。

Run には次を保存します。

- source snapshot
- OpenTofu version
- provider lock digest
- ProviderBinding
- 注入した env の metadata (値そのものは保存しません)
- plan / apply の結果
- state version
- outputs
- logs
- actor
- audit evidence

`Source.defaultRef` は branch / tag / commit を受け取ります。`Source.autoSync`
を有効にすると、scheduler または source webhook が Git ref を同期します。解決された
commit は `SourceSnapshot` として保存されます。active Capsule がその Source を追跡して
いて、現在 apply 済みの SourceSnapshot と新しい commit が異なれば、Capsule は `stale`
になります。そこからは既存の Workspace update / RunGroup が reviewable plan を作り、
apply は通常の Run approval に従います。app artifact をどこから取るかは、あくまで
OpenTofu module の中で決まります。

明示的な更新確認では、先に Source を同期し、その要求が生成した変更不可の
`SourceSnapshot` を compatibility check と plan に固定します。既存の古い snapshot を
「最新」として流用してはいけません。session API では次の intent を使えます。

```http
POST /api/v1/sources/{sourceId}/sync
Content-Type: application/json

{ "intent": "manual_plan" }
```

`observe` (省略時) は webhook / scheduler の観測用で、Capsule が opt-in
していれば auto-update を評価できます。`manual_plan` はユーザーが確認する plan
のための同期で、その sync 自体から別の auto-update plan/apply を開始しません。
クライアントは、返された SourceSyncRun が `succeeded` になるまで待ちます。その Run の
`sourceSnapshotId` が一覧に現れてから、compatibility check と plan を続けます。

## Deploy API / Resource Shape API

`/v1/resources` は provider-neutral な managed Resource の Deploy API です。preview /
apply / observe / refresh / import / delete をここで受け取ります。canonical Resource、
ResolutionLock、NativeResource、Run、status、Output、audit の唯一の lifecycle authority
も、この API です。CLI、dashboard、Takoform host API と明示的に導入した
protocol adapter は、いずれもこの API の client です。

multi-tenant platform には session、personal access token、service token、OAuth token の
経路があります。どの経路でも、request の `space` は検証済みの Workspace id と一致して
いなければなりません。platform worker は query、top-level body、`metadata.space` の
すべてを照合してから internal actor へ変換します。異なる Space は `403` で拒否します。
Core は暗黙の Space-to-Workspace mapping を作りません。別の Space を管理できるのは、
direct deploy-control bearer を持つ operator 経路と、将来の明示的に検証された mapping
だけです。

control-plane Compatibility API は、対応範囲の request を typed Resource request へ
変換してこの Deploy API を呼びます。lifecycle row、resolver decision、backend selection
は、いずれも Deploy API 側にあります。data-plane Compatibility API は、backend へ
到達する前に解決を行います。対象は Ready な canonical Resource と、認可済みの
Interface / NativeResource evidence です。

Core は既定では Resource kind を 1 つも広告・受理しません。host composition が code
として schema authority を install します。そのうえで、desired state の作成・変更を
許可する kind を明示的に enable します。現在の Takos / Takosumi composition は、凍結した
10 種の v1alpha1 compatibility set を明示的に install します。どれを write-enabled に
するかは operator の `TAKOSUMI_RESOURCE_SHAPES` が選びます。install 済みでも write-disabled に
なった kind は、retained Resource の state/event read、明示 observe、delete を継続
できます。この migration compatibility も、同じ canonical Resource / Run ledger を
使います。

```http
POST   /v1/resources/preview
PUT    /v1/resources/{kind}/{name}
POST   /v1/resources/{kind}/{name}/import
GET    /v1/resources/{kind}/{name}?space={spaceId}
GET    /v1/resources/{kind}/{name}/events?space={spaceId}&limit={1..100}&cursor={opaque}
POST   /v1/resources/{kind}/{name}/observe?space={spaceId}
POST   /v1/resources/{kind}/{name}/refresh?space={spaceId}
DELETE /v1/resources/{kind}/{name}?space={spaceId}
GET    /v1/resources?space={spaceId}&limit={1..100}&cursor={opaque}
```

OSS の preview は価格を要求しません。commercial billing extension を有効にした Cloud
endpoint では、billable preview が `DeploymentQuote` を返します。quote の根拠は
versioned な `ServiceOffering` / `PriceCatalog` です。apply では `quoteId + quoteDigest`
が必須になります。quote が固定するのは、Resource spec digest、resolution fingerprint、
offering/catalog version です。SKU line items、currency、estimated total micros、
issued/expiry も同じ quote が固定します。Cloud は backend 作業の前に reserve し、
Resource が成功したら capture、失敗や cancel なら release します。そのうえで rated
UsageEvent と payment-provider の invoice line を照合します。これらの wire field は
versioned commercial extension contract として広告します。OSS の Resource object に
Cloud 専用の field は現れません。

Resource 一覧は `createdAt` と Resource id による keyset pagination です。最終ページ
以外では `nextCursor` を返すため、client は内容を解釈せず次の `cursor` へそのまま
渡します。`limit` 省略時は 100 件、最大も 100 件です。

`observe` は保存済み `ResolutionLock` の Target / implementation をそのまま使う
read-only drift check です。OpenTofu-backed Resource では、apply 不能な
`drift_check` Run を作ります。plugin-backed Resource では、adapter の `observe` action
を呼びます。観測結果は CAS fence 付きで `Drifted` / `Reconciling` / `Degraded`
condition に反映されます。観測中に apply / delete が進んだ場合は、古い結果で Resource を
上書きしません。drift を見つけても自動 apply や Target の再選択は行わず、現在の
revision と endpoint を固定したまま報告します。

platform worker の scheduled observation も同じ `observe` を使います。有効な
Resource Shape がある host では、既定で有効になります。観測するのは `Ready` かつ現
generation の Resource だけで、全 Space を横断して古い順に見ます。重複を避けるために
期限付きの lease を取ります。既定は 1 時間間隔、1 tick 最大 8 件、同時 4 件です。
これは内部 scheduler の状態です。operator は頻度・batch・並列数・lease、または機能
自体を環境変数で調整できます。

`refresh` は同じ pinned Target / implementation に対して実行します。内容は OpenTofu の
`plan -refresh-only` と保存済み plan の apply、または plugin の `refresh` action です。
native provider resource は変更せず、Resource-owned state と public Output だけを
更新します。成功したときだけ、影響を受ける Interface の revision を再解決します。
実行中は CAS claim で通常の apply/delete と直列化し、失敗時は Resource を `Failed`、
Interface を `Unknown` に固定します。refresh-only plan の drift changes は resource の
作成・更新課金として扱わず、runner usage だけを別に記録します。

`import` は既存の backend resource を Takosumi の Resource ledger へ取り込みます。request
body は通常の Resource object と top-level の `nativeId` を含みます。Target の
implementation には条件があります。plugin であるか、明示的な `moduleImportAddress`
(child module 内の `resource_type.name`) を宣言していることです。OpenTofu-backed
import は生成 root へ `import` block を追加し、通常の `Run` として plan します。
保存済み plan を apply する
のは、plan JSON が `change.importing` をちょうど 1 件含み、create/update/delete を一切
含まない場合だけです。apply が済むと Resource-owned state / Output / NativeResource を
公開します。plugin-backed import も read-only inventory lookup に限ります。失敗した
未公開 record は backend delete を呼ばずに削除できます。`nativeId` は provider-native な
identifier なので、secret を渡してはいけません。

Resource event は `/events` から新しい順の keyset page として取得できます。これは
共有 Activity / Run audit ledger を `space + resourceId` で絞った non-secret projection
です。Resource record を削除したあとも監査履歴は取得できます。`metadata` が持つのは
phase、generation、identifier、count だけで、credential、raw error、spec、state、
Output の値は公開しません。

Resource Shape API は現在の Service Form host compatibility surface であり、typed shape を
前提にします。採用済み target の exact FormRef / Form Package / FormActivation も
同じ扱いです。additive migration のあとも、同じ Resource / Run / state / audit ledger
へ解決されます。通常 interface として `takosumi_resource { type, spec }` のような
全部入り resource は公開しません。

### FormActivation の operator API

operator は exact な installed FormRef を generic・noncommercial な
FormActivation API で audience に公開します。

```http
POST  /v1/form-activations
GET   /v1/form-activations?limit={n}&cursor={opaque}
GET   /v1/form-activations/{id}
PATCH /v1/form-activations/{id}
```

この route は operator deploy-control bearer を必須とし、customer session / PAT
では変更できません。`createdBy` / `updatedBy` は request JSON ではなく認証済み
operator から決まります。create は exact `FormRef` + `packageDigest` を固定します。
update は `expectedRevision` CAS を使い、結果の revision を `ETag` で返します。未知の
field は拒否します。そのため price、SKU、payment、billing、managed capacity、region
inventory、SLA、support を OSS policy record に混ぜることはできません。商用の
availability は、同じ exact identity と activation を参照する closed ServiceOffering
側に残ります。

operator CLI はこの API へ直接対応します。

```bash
takosumi form-activations list --url "$TAKOSUMI_DEPLOY_CONTROL_URL"
takosumi form-activations create --file activation.json
takosumi form-activations update activation_id --file update.json
```

### Form の利用可否を確認する

認証済み principal は exact FormRef ごとの host 状態を read-only で取得できます。

```http
GET /v1/form-availability?space={space}&limit={n}&cursor={opaque}
```

完全一致 lookup は `type` / `version` / `schemaDigest` / `packageDigest` を
すべて指定します。レスポンスは
`definitionKnown` / `installed` / `executable` / `executableReason` /
`activated` / `availableToPrincipal` / `availabilityReason` を返します。あわせて
`operations` / `compatibleAdapterIds` / `eligibleTargetPoolClasses` / `deprecated`
も返します。`forms:read` または `resources:read` scope が必要です。

判定は根拠が揃わなければ安全側に停止します。根拠になるのは、Form Registry、installed schema、
TargetPool descriptor、実際に注入済みの module/adapter、FormActivation の scope/audience
です。Target 名、implementation/manager identity、credential、region、raw capacity は
返しません。価格、SKU、請求、Cloud offering は別の closed catalog の責務です。

`GET /v1/capabilities?space={space}` も同じ認証・scope で使えます。その principal の
structured record を `formAvailability.forms` に投影します。この scoped projection
では legacy `resources` boolean も `availableToPrincipal` から導出されます。
`space` なしの capability document は、未移行 client 向けの context-free な host
enablement view です。principal ごとの availability の根拠にはできません。

```bash
takosumi form-availability list --space space_1
```

現在の v1alpha1 public shape:

```text
EdgeWorker
ObjectBucket
KVStore
Queue
SQLDatabase
ContainerService
VectorIndex
DurableWorkflow
StatefulActorNamespace
Schedule
```

Takos のような複合 product も、専用の `takosumi_takos` resource ではなく、
この汎用 shape の合成として表します。例えば `takos-worker` は `EdgeWorker`、
workspace/control DB は `SQLDatabase` です。file/workspace object は `ObjectBucket`、
agent job / event は `Queue`、`takos-agent` は `ContainerService` になります。別途
install する `takos-git` は自身の generic service topology を持ちます。足りない
service form が出た場合だけ、同じ prior-art gate を通して新しい typed shape を追加します。

`EdgeWorker` や `ContainerService` のような消費側 shape は `connections`
で他の shape への非 secret 接続を宣言できます。ここに置けるのは resource
reference、permissions、projection kind だけです。credential や実際の binding
生成は Credential / ProviderConnection / adapter 側が扱います。
HCL では `connection` は予約語なので、provider surface は `connections = [...]`
です。

`ObjectBucket` があっても、data-plane は S3-compatible API を使います。
`spec.storageClass` は新規 object の provider-neutral な既定 class です。exact value は
`standard` / `infrequent_access` で、省略時は `standard` に正規化します。
`infrequent_access` を解決できるのは、TargetPool が `storage_class_infrequent_access`
capability を公開するときだけです。未対応なら backend 呼び出しの前に失敗します。既存
object の class を暗黙に変更する selector ではありません。
`AI Gateway` は provider resource ではなく OpenAI-compatible endpoint と env/secret
projection として扱います。

## Target / Credential / Policy API

Resource Shape の backend は HCL に直接書きません。TargetPool / Policy /
capability evidence / ResolutionLock で決まります。
これは operator/advanced API です。通常の deploy UX は service form、必要な入力、
価格、preview、apply だけを表示し、TargetPool / Policy / Adapter を要求しません。
`/v1/capabilities.adapters` は adapter token を boolean で返します。Core が必ず返す
key は `opentofu` だけです。ほかの key はすべて operator が
`TAKOSUMI_RESOURCE_ADAPTERS` で宣言した open token で、固定の一覧はありません。
adapter を足すのは既存の typed shape に実装先を増やすための拡張です。新しい shape を
足すには、schema / API / provider の release が必要になります。

```http
PUT    /v1/target-pools/{name}
GET    /v1/target-pools/{name}?space={spaceId}
GET    /v1/target-pools?space={spaceId}&limit={1..100}&cursor={opaque}
DELETE /v1/target-pools/{name}?space={spaceId}

PUT    /v1/space-policies/{name}
GET    /v1/space-policies/{name}?space={spaceId}
GET    /v1/space-policies?space={spaceId}&limit={1..100}&cursor={opaque}
DELETE /v1/space-policies/{name}?space={spaceId}
```

operator が既定 pool を bootstrap するときは、同じ PUT に
`If-None-Match: *` を付けると atomic create-only になります。作成は `201`、同じ
Space/name が既にあれば `412 target_pool_exists` で、既存の capability evidence を
上書きしません。header なしの PUT は明示的な create/update です。

Target は TargetPool の `spec.targets[]` に、operator が完全な capability evidence
として宣言します。Resource Shape flow の SpacePolicy は、同じ Space-scoped endpoint で
保存・取得・一覧・削除します。`TargetPool.spec.classes` が持つのは、FormActivation の
`eligibleTargetPoolClasses` と照合する公開 placement class token だけです。target 名、
credential、region、manager、capacity のような private な placement 情報を discovery へ
投影するフィールドではありません。

provider の実行 credential は、OpenTofu Stack flow の ProviderConnection と Credential
Recipe が所有します。Recipe の `authModes` key と `preRun.type` は、operator/provider が
公開する open token です。Core は `static` / `oidc` / cloud vendor のような固定 taxonomy
を持ちません。secret value は write-only で、Run 時だけ recipe に従って env/file に
書き出されます。

## OIDC と workload identity

Takosumi Accounts は登録済み OIDC client のための標準 issuer surface を公開します。

```http
GET  /.well-known/openid-configuration
GET  /oauth/jwks
GET  /oauth/authorize
POST /oauth/token
```

独立した ServiceAccount / workload federation API は現在の public surface にはありません。
AWS / GCP / Kubernetes ごとの固定 route や credential kind も Core には追加しません。
将来の workload identity は、汎用 OIDC principal、Resource Credential / Policy、または
Credential Recipe の明示的な pre-run action として設計します。公開するのは、実装と
discovery が揃ってからです。
Operator / Cloud はその汎用 seam に Enterprise SSO、SCIM、商用 audit export を追加できます。

Capsule が公開する OIDC client は `installExperience.oidc_client.scopes`
で必要な scope を宣言できます。`openid` は必須です。Accounts が発行する
`capsules:read` / `capsules:write` access token は単一 Workspace に束縛されます。
canonical Capsule ledger の参照と Interface 呼び出しでは、scope と Workspace の
両方を検証します。`offline_access` を許可した client は refresh token を受け取れます。
token の実体は利用側の secret store に暗号化して保存し、OpenTofu state や Output には
保存しません。

## Compatibility API

Compatibility API は標準 protocol / API の scoped facade です。control-plane profile は
Deploy API の translation client として働きます。data-plane profile は、canonical な
Ready Resource への認可済み access surface になります。

| profile | 範囲 |
| --- | --- |
| `compat.s3.v1` | S3 互換の Object Storage の data / control path |
| `compat.oci.v1` | Artifact / ContainerImage の lifecycle |
| `compat.cloudevents.v1` | Queue / EventHandler への event ingress |
| `compat.kubernetes.crd.v1` | Kubernetes northbound API |
これは full vendor API 互換を意味しません。範囲は capability と
compatibility matrix で明示します。

Takoform host API、明示的に導入した protocol adapter、dashboard、CLI は公開する
protocol がそれぞれ違っても、同じ Resource desired state と Deploy API lifecycle
に収束します。
data-plane profile は既存 Resource を暗黙作成せず、Ready な Resource を解決します。
表現できない操作は互換のように成功させず、compatibility matrix で範囲を明示して
安全側に停止します。

managed hostname を作る compatibility route / script-subdomain write は、source Workspace と
source Capsule のコンテキストを必須とします。hostname の予約管理は Capsule Run と同じ
OSS の仕組みです。Cloud extension の KV / Durable Object などが持つ routing / activation
state は、hostname 所有権の正本ではありません。route-level の DELETE はその state だけを
削除し、Capsule lifetime に属する reservation は解放しません。

Takosumi Cloud 固有の endpoint 例は
[Cloud endpoints](https://app.takosumi.com/docs/endpoints) を見てください。

## エラーの形式

失敗した response は structured error を返します。

```json
{
  "error": {
    "code": "capability_not_available",
    "message": "requested capability is not enabled for this endpoint",
    "requestId": "req_123"
  }
}
```

secret の値、一時的な credential、内部 adapter の credential は error に含めません。

## バージョン

現在の API version は `takosumi.dev/v1alpha1` です。

| version | 位置づけ |
| --- | --- |
| `v1alpha1` | 破壊的変更あり。docs と conformance を同時に更新する |
| `v1beta1` | 大枠は固定。upgrade / conversion guidance を必須とする |
| `v1` | 後方互換を維持。field は削除しない |

OSS / Operator / Cloud の違いは API version ではなく capabilities で表します。
