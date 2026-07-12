# Operator

Operator は Takosumi for Operator を自分のユーザー向けに運用する主体です。

Takosumi OSS は Git ベースの OpenTofu control plane、Resource Shape API、Compatibility API フレームワーク、Adapter system を持ちます。
Takosumi for Operator は、その上に顧客管理、billing / metering / quota、DB ベースの operator 設定、
CLI/API/runbook による運用、managed target catalog、商用運用を追加して提供します。Takosumi Cloud は私たちが運用する公式の hosted サービスです。

## 責任範囲

- control-plane の認証 / token 境界を設定する
- runner の実行基盤 / runner image / resource limits / provider allowlist seed を定義する
- CredentialRecipe seed、provider allowlist、ProviderConnection policy を管理する
- ProviderConnection の封印済み backing material / secret 配信を管理する
- Resource Shape / TargetPool / Adapter / compatibility profile の有効性を管理する
- state backend と lock backend を管理する
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

Resource Shape:
Resource
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

## 本番環境への準備

OSS Operator GA の準備状況は以下です。

| 領域               | 必要な証跡                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Website/docs       | ドキュメントビルド、公開する場合はカスタムドメイン/TLS                                                                        |
| Runner             | 非本番環境での OpenTofu plan/apply/destroy の実証                                                                             |
| Release activation | webhook/materializer の実証、activation 失敗の表示、アプリ公開を有効にする場合は rollback 独立の履歴証跡                       |
| Accounts/auth      | dashboard、session/OIDC（設定に応じて）、audit trail                                                                          |
| State              | state backend、lock の証跡、backup/restore ドリル                                                                            |
| Secrets            | 暗号化ストレージ、ローテーション手順、秘匿処理の証跡                                                                          |
| Provider recipes   | CredentialRecipe seed、provider allowlist、ProviderConnection policy、ヘルパーのカバレッジ                                    |
| Resource shapes    | TargetPool policy、adapter capability の証跡、ResolutionLock の動作                                                          |
| Compatibility      | スコープ・バージョン指定の capability 一覧、非対応 API の不在証明                                                             |
| Network            | provider allowlist と egress の適用                                                                                           |
| Tenant isolation   | Workspace/team の分離と runner の分離                                                                                        |
| Audit              | Run、secret、state、管理者操作の証跡                                                                                         |

Cloud GA では追加で、公式 managed target、hosted compatibility profile、公式 billing、
abuse 対策、support、usage metering、deprovision の証跡が必要になります。
