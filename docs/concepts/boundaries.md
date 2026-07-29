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
- 型付き Resource を扱うための共通 lifecycle
- デプロイしたものの接続先と利用許可を記録する仕組み

どのクラウドを使うかは module、provider、または運用者が導入した Resource の実装が
決めます。Takosumi OSS は特定のクラウドアカウントや provider を必須にしません。

## 運用者が決めるもの

同じ Takosumi を動かしていても、設置先によって次は異なります。

- 利用できる Resource の種類
- Resource を実際に作るクラウドと実装
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
managed リソースの実装、公式の容量、料金と支払い、support、SLA、abuse 対策です。

これらは OSS の一般仕様ではありません。料金や利用上限を確認するときは
[Takosumi Cloud のドキュメント](https://app.takosumi.com/docs/)を参照してください。

Cloud 側の実装は OSS の contract を利用しますが、OSS から Cloud の private code や
Stripe へ依存することはありません。

## Takoform の位置づけ

Takoform は、Resource の形を provider やクラウドから分離して記述するための独立した
仕様とツールです。Takosumi は Takoform を受け付けることができますが、Takoform だけが
Resource の入口ではありません。

同様に、Cloudflare、AWS などの Terraform / OpenTofu provider は runner から見て通常の
provider です。Takosumi Cloud も、利用者が接続した別のクラウドも、共通の Run と
Resource lifecycle を通ります。

## self-host する場合

自分で Takosumi を運用する場合は、あなたが上記の運用者になります。software update、
secret、データベース、runner、バックアップ、Resource の実装を自分で管理します。

構成の選び方は[自分で動かす](./self-host.md)、具体的な作業は
[リポジトリの運用手順](https://github.com/tako0614/takosumi/blob/main/docs/operations/README.md)に
あります。
