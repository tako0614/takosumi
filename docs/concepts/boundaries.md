# Takosumi と Takosumi Cloud

同じ名前がソフトウェアと公式サービスを指さないよう、このドキュメントでは次のように
区別します。

| 名前               | 意味                                                 |
| ------------------ | ---------------------------------------------------- |
| **Takosumi**       | このリポジトリで公開している AGPL-3.0 のソフトウェア |
| **Takosumi Cloud** | `app.takosumi.com` で提供する公式ホスティング        |

## ソフトウェアが提供するもの

Takosumi OSS には次が含まれます。

- Git module の plan、apply、state、output、監査記録
- provider の接続情報を保存し、runner に安全に渡す仕組み
- dashboard、API、CLI、サインイン
- デプロイしたものの接続先と利用許可を記録する Interface / InterfaceBinding
- 任意の OpenTofu / Terraform provider を接続する ProviderConnection / ProviderBinding

どのクラウドを使うかは module、provider、または運用者の構成が決めます。Takosumi OSS
は特定のクラウドアカウントや provider を必須にしません。Takoform は普通の provider
として OpenTofu runner から使われます。provider 側の object を別の resource ledger に
複製して、第二の lifecycle を作ることもしません。

Resource Shape / Form Host を Takosumi OSS が提供する、という旧来の説明は廃止しました。
Form の定義、provider、package、hosted instance は Takoform または Takosumi Cloud
などの外部 Host が所有します。OSS に残る Resource API、schema、migration は過去の
保存データを安全に扱うための temporary migration internals であり、supported product
としての authoring surface ではありません。

## 運用者が決めるもの

同じ Takosumi を動かしていても、設置先によって次は異なります。

- 利用する provider とその実行環境
- 外部 Host または Takosumi Cloud が提供する hosted Form instance
- 保存容量、利用上限、バックアップ期間
- 利用量を記録するだけか、請求まで行うか
- 更新、障害対応、support、SLA

その endpoint が提供する機能は、名前や edition から推測せずに確認します。

```bash
curl https://takosumi.example.com/.well-known/takosumi
```

または、認証済みの API から `/v1/capabilities` を取得します。

## Takosumi Cloud が追加するもの

Takosumi Cloud は、Takosumi OSS を運用した公式サービスです。Cloud が追加するのは、
Cloud が提供する hosted Form/service の実装、公式の容量、料金と支払い、support、SLA、abuse 対策です。

これらは OSS の一般仕様ではありません。料金や利用上限を確認するときは
[Takosumi Cloud のドキュメント](https://app.takosumi.com/docs/)を参照してください。

Cloud 側の実装は OSS の contract を利用しますが、OSS から Cloud の private code や
Stripe へ依存することはありません。

## Takoform と外部 Host の位置づけ

Takoform は Form の仕様、provider、package、conformance を所有する独立したプロジェクト
です。Takosumi からはほかの OpenTofu provider と同じように利用します。Form を保存して
実行する Host や hosted instance を Takosumi OSS が自動で提供するわけではありません。

同様に、Cloudflare、AWS などの Terraform / OpenTofu provider は runner から見て通常の
provider です。ただし、実行後の authority は同じではありません。

- Cloudflare / AWS などの provider を module から直接使う場合は、共通の
  Run、state、output、監査記録を使います。provider 側の resource は必ずしも
  Takosumi の Resource 台帳には入りません。
- Takoform の host または Takosumi Cloud が hosted Form instance を提供する場合、その
  lifecycle と実装の authority は外部 Host 側にあります。
- Takosumi OSS の runner が Cloud 専用の provider や TargetPool を暗黙に選ぶ仕組みは
  ありません。

## self-host する場合

自分で Takosumi を運用する場合は、あなたが上記の運用者になります。software update、
secret、データベース、runner、バックアップ、provider の構成を自分で管理します。Form
instance を使う場合は、その外部 Host の契約と運用境界も確認します。

構成の選び方と公開手順は[自分で動かす](./self-host.md)にあります。repository 内の
operator runbook は利用者向け仕様ではありません。
