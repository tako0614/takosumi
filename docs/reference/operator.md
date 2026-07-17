# Operator

Operator は Takosumi for Operator を自分のユーザー向けに運用する主体です。

Takosumi OSS は Git ベースの OpenTofu control plane、zero-form 対応の optional Service Form host（現在の Resource Shape
互換 API）、Compatibility API フレームワーク、Adapter system を持ちます。portable project は Service Form / FormRef /
data-only Form Package / typed client conformance を所有し、Takosumi operator は package pin、trusted implementation、
Target / Policy / credential、generic FormActivation を所有します。
Takosumi for Operator は、その上に顧客管理、billing / metering / quota、DB ベースの operator 設定、
CLI/API/runbook による運用、managed target catalog、商用運用を追加して提供します。Takosumi Cloud は私たちが運用する公式の hosted サービスです。

## 責任範囲

- control-plane の認証 / token 境界を設定する
- runner の実行基盤 / runner image / resource limits / provider allowlist seed を定義する
- CredentialRecipe seed、provider allowlist、ProviderConnection policy を管理する
- ProviderConnection の封印済み backing material / secret 配信を管理する
- Form Registry / implementation / FormActivation / TargetPool / Adapter / compatibility profile の有効性を管理する
- FormActivation は operator-bearer `/v1/form-activations` API または
  `takosumi form-activations` で運用し、price / payment / capacity / SLA を
  activation policy に入れない
- Service Form-backed Resource の scheduled observation の頻度・batch・並列数を runner capacity に合わせて管理する
- state backend と lock backend を管理する
- production / staging では database URL の形式から保存時暗号化を推測せず、storage adapter の証跡、または確認済みの
  `TAKOSUMI_DATABASE_ENCRYPTION_AT_REST=verified` と非 secret の
  `TAKOSUMI_DATABASE_ENCRYPTION_EVIDENCE` を設定する
- OpenTofu runner image / local/docker/remote/operator runner pool を管理する
- Workers for Platforms を使う場合は tenant/user Worker の ingress 境界として扱い、OpenTofu runner の実行境界と分ける
- 顧客 / billing / metering / quota / support の運用を行う
- 必要な場合は release activator materializer を運用し、apply 履歴とアプリ公開結果を分けて記録する
- provider credential / control-plane token / state backend credential をユーザーの workload に渡さない
- ユーザー向け dashboard / API / audit / quota / usage showback を運用する
- operator 専用の操作は DB ベースの設定 / CLI / API / runbook / audit 証跡で扱う
- tenant isolation、Workspace isolation、runner pool isolation、network egress policy の証跡を持つ

## OSS の境界

Takosumi OSS の可搬な境界は 2 つです。

```text
Git / OpenTofu stack:
ProviderConnection
  -> CredentialRecipe
  -> temporary env/file injection
  -> OpenTofu/Terraform provider

Service Form host (current Resource Shape API):
exact FormRef + Resource
  -> installed definition / implementation / FormActivation
  -> TargetPool / Policy / Credential
  -> Adapter capability
  -> ResolutionLock
  -> NativeResource
```

Operator は必要な場合だけスコープ指定・バージョン指定の compatibility profile を有効にできます。例:
`compat.s3.v1`、`compat.oci.v1`、`compat.cloudevents.v1`。既存の OpenTofu provider や標準 endpoint
で足りる場合はそれを使い、Takosumi 側で再実装しません。公開範囲は `/v1/capabilities` で示し、
AWS API 完全互換や Cloudflare API 完全互換は名乗りません。

## Operator / Cloud の境界

Operator / Cloud が持つのは商用運用と managed capacity です。

```text
customer management
billing / metering / quota / plan
DB-backed operator configuration
CLI / API / runbook operations
managed target catalog
support / abuse operation
commercial audit
operator-owned target pools
```

Takosumi Cloud は公式の hosted deployment であり、以下を公式 managed service として運用します。

```text
official resource pools
Takosumi Native Runtime
Takosumi Native Object Store
Takosumi Native Queue
Takosumi Native DB
Takosumi Edge Gateway
Takosumi AI Gateway
official billing / quota / usage / support / SLA
```

公式 managed capacity の実装・テスト・secrets・デプロイ設定は非公開の Cloud リポジトリに置きます。

## Service Form-backed Resource scheduled observation

platform worker は、有効な current Resource Shape compatibility kind がある場合に read-only の scheduled observation を既定で実行します。
対象は現 generation の適用が完了した `Ready` Resource だけです。観測は pinned Target / implementation に対する
`drift_check` Run であり、apply / refresh は行いません。候補選択は全 Space 横断の durable lease で重複を防ぎ、
失敗した Resource が同じ tick の別 Resource を止めることもありません。

| 変数                                             | 既定値 | 許容範囲       | 意味                                     |
| ------------------------------------------------ | ------ | -------------- | ---------------------------------------- |
| `TAKOSUMI_RESOURCE_OBSERVATION_ENABLED`          | 自動   | `0` / `1`      | 未設定時は有効な shape kind があれば有効 |
| `TAKOSUMI_RESOURCE_OBSERVATION_BATCH`            | `8`    | `1`–`32`       | 1 tick でclaimする最大Resource数         |
| `TAKOSUMI_RESOURCE_OBSERVATION_CONCURRENCY`      | `4`    | `1`–`8`        | 同時に実行する最大観測数                 |
| `TAKOSUMI_RESOURCE_OBSERVATION_INTERVAL_SECONDS` | `3600` | `300`–`604800` | 同一Resourceの最小観測間隔               |
| `TAKOSUMI_RESOURCE_OBSERVATION_LEASE_SECONDS`    | `900`  | `600`–`7200`   | abandoned claimを再取得できるまでの時間  |

範囲外または不正な値は安全な既定値に戻ります。batchを無制限に増やす用途ではなく、runner poolの容量に合わせて
小さく保ってください。観測結果は `takosumi_resource_observation_count` metric の `outcome` labelで確認できます。

## 本番環境への準備

OSS Operator GA の準備状況は以下です。

| 領域               | 必要な証跡                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Website/docs       | ドキュメントビルド、公開する場合はカスタムドメイン/TLS                                                             |
| Runner             | 非本番環境での OpenTofu plan/apply/destroy の実証                                                                  |
| Release activation | webhook/materializer の実証、terminal success gate、失敗時の state/output 保持と Run/Capsule/Interface 非Ready証跡 |
| Accounts/auth      | dashboard、session/OIDC（設定に応じて）、audit trail                                                               |
| State              | state backend、lock の証跡、backup/restore ドリル                                                                  |
| Secrets            | 暗号化ストレージ、ローテーション手順、秘匿処理の証跡                                                               |
| Provider recipes   | CredentialRecipe seed、provider allowlist、ProviderConnection policy、ヘルパーのカバレッジ                         |
| Resource shapes    | TargetPool policy、adapter capability の証跡、ResolutionLock の動作                                                |
| Compatibility      | スコープ・バージョン指定の capability 一覧、非対応 API の不在証明                                                  |
| Network            | provider allowlist と egress の適用                                                                                |
| Tenant isolation   | Workspace/team の分離と runner の分離                                                                              |
| Audit              | Run、secret、state、管理者操作の証跡                                                                               |

Cloud GA では追加で、公式 managed target、hosted compatibility profile、公式 billing、
abuse 対策、support、usage metering、deprovision の証跡が必要になります。
