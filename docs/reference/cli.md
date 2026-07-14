# CLI

Takosumi CLI は、画面でできる操作を自動化したい場合の補助ツールです。通常は
dashboard の `/install?git=...` / `/new` からサービスを選び、接続する provider を選んで
plan / apply します。CLI は任意の Takosumi endpoint に向けて使えます。

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>

open "$TAKOSUMI_DEPLOY_CONTROL_URL/install?git=https://git.example.com/example/photo-blog.git&path=deploy/opentofu&ref=v1.0.0"

takosumi status <run-id>
takosumi logs   <run-id>
```

Takosumi Cloud を使う場合の hosted endpoint は `https://app.takosumi.com` です。

CLI は OpenTofu を直接実行しません。通常の作成フローは dashboard の Git URL install で
Source / Capsule / Run を作り、Run の source identity として Git commit / ref / path を固定します。実行は runner sandbox で行い、
credential は ProviderConnection と CredentialRecipe から Run 実行時だけ env/file として注入されます。
`takosumi deploy` / `takosumi plan` のローカルアップロード経路は廃止済みです。

## Platform readiness contributions

`takosumi launch-readiness template` は OSS/Operator に共通する baseline を生成します。
hosted service や別の edition が追加の運用証跡を要求する場合は、owner 側が versioned
`PlatformReadinessContribution` JSON を管理し、template 生成時に
`--contribution-file <path>` で選択します。

```bash
takosumi launch-readiness template \
  --contribution-file <owner-controlled-contribution.json> \
  > readiness.private.json

takosumi launch-readiness validate --file readiness.private.json
```

生成される `takosumi.platform-readiness@v2` document は contribution の `id` / `version` /
`capability` と追加 requirement / evidence schema を埋め込みます。そのため validate と
public-summary は provider 固有コードや外部 registry lookup を使わず、その document だけで
fail-closed に検証できます。別 version の contribution は同じ readiness profile として暗黙に
扱いません。旧 baseline ID は validate 時に二重解釈せず、明示的な
`launch-readiness migrate-final-model` で一度だけ更新します。

任意の collector DSL は持ちません。contribution が collection planning を補助する場合は、
contribution 自身が定義した evidence type を既存の固定 class
(`browser-user-e2e` / `external-provider` / `operator-review` /
`live-probe-sync` / `operation-drill` / `release-provenance`) へ割り当てる
`collectionClassHints` だけを使えます。hint を省略した extension evidence は validation
上は有効なまま、collection planning では uncategorized になります。

## Connections

Provider credential の値はファイルから読み込み、表示しません。

```bash
takosumi connections create \
  --provider registry.opentofu.org/example/example \
  --recipe generic-env \
  --auth-mode env \
  --secret-partition provider-credentials \
  --values-file <path-to-credential-env-json>

takosumi connections list
takosumi connections test conn_...
takosumi connections revoke conn_...
```

Compatibility API は operator が extension capability として明示的に構成します。CLI の
Provider Connection surface は特定 Gateway や provider family を暗黙に選びません。

## Resource Shape

Resource Shape flow は、別の sync registry を持たず、Takosumi に保存された Resource / TargetPool /
SpacePolicy 宣言と明示的な reconcile operation をそのまま操作します。write request は non-secret
JSON object を file から読みます。通常出力は Resource の phase、Target、Run id などの要約だけで、
request body や Output 値を表示しません。完全な public response が必要な場合だけ `--json` を指定します。

```bash
takosumi resources preview --file resource.json
takosumi resources apply EdgeWorker api --file resource.json
takosumi resources import EdgeWorker api --file resource-with-native-id.json

takosumi resources list --space space_...
takosumi resources get EdgeWorker api --space space_...
takosumi resources events EdgeWorker api --space space_...
takosumi resources observe EdgeWorker api --space space_...
takosumi resources refresh EdgeWorker api --space space_...
takosumi resources delete EdgeWorker api --space space_...
```

`preview` / `apply` の file は Resource Shape API と同じ `kind` / `metadata` / `spec` を持ちます。
`import` はそれに top-level の `nativeId` を足します。credential や secret は Resource spec や
`nativeId` に入れず、ProviderConnection / CredentialRecipe で管理します。`delete --force` は endpoint
側で operator break-glass 認可が明示されている場合だけ成功します。

Target と Policy の宣言も同じ endpoint に直接送ります。

```bash
takosumi target-pools put default --file target-pool.json
takosumi target-pools list --space space_...
takosumi target-pools get default --space space_...
takosumi target-pools delete default --space space_...

takosumi space-policies put default --file space-policy.json
takosumi space-policies list --space space_...
takosumi space-policies get default --space space_...
takosumi space-policies delete default --space space_...
```

`target-pool.json` は top-level の `space` と `spec.targets`、`space-policy.json` は top-level の
`space` と `spec` を持つ API request body です。一覧の `nextCursor` は opaque なので、次ページでは
内容を解釈せず `--cursor` に渡します。

## Deployment secrets

deployment runtime の secret 保存・適用は、その runtime adapter と operator vault が所有します。
Takosumi CLI は Wrangler、特定 Worker、固定 secret 名を正本にせず、Provider credential は
`connections` から Provider Connection として登録します。platform service の signing key や
internal bearer は repo 外で生成・保管し、選んだ deployment adapter の native secret command で
適用してください。
