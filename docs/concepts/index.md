# 仕組みの全体像

Takosumi はクラウド API の代わりではありません。OpenTofu / Terraform と既存 provider
を実行し、その前後に確認、認可、記録を加えます。

## 最初に覚える 6 つ

| 名前          | 普通の言葉でいうと                                                     |
| ------------- | ---------------------------------------------------------------------- |
| **Workspace** | 個人の用途・リソース・セキュリティを分ける入れ物。共有は必要なときだけ追加 |
| **Project**   | Workspace 内でアプリやインフラを整理する単位                           |
| **Source**    | 登録した Git リポジトリと module の場所                                |
| **Capsule**   | Source から作った、1 つの module のデプロイ単位                        |
| **Run**       | plan、apply、refresh、destroy など 1 回の実行                          |
| **Interface** | デプロイしたものが提供する接続方法の宣言                              |

Workspace はチームや権限を最初に作るためのものではありません。Personal、Work、
Experiments、Client など、目的ごとの作業・リソース・認可境界です。必要な場合だけ
メンバーシップと共有を追加します。表示名が主な識別子で、`handle` は API / CLI で使う
安定したグローバル一意の技術識別子です。ダッシュボードでは通常自動生成し、名前が
重複したときや詳細設定でだけ表示します。`production` や `preview` のような具体的な
実行環境は Capsule に属し、Workspace の別名ではありません。

state、output、ログ、監査記録は Run の結果です。provider の API key などは
**Connection** として別に保存し、必要な Run にだけ割り当てます。

細かな型名や API 上の名前は[用語集](../reference/glossary.md)にあります。最初から
すべて覚える必要はありません。

## Git module をデプロイする

```text
1. Git URL、ref、module path を Source として登録
2. ref を 1 つの commit に固定
3. module から Capsule を作成
4. Connection と入力変数を割り当て
5. plan を実行
6. 差分を確認して apply
7. state、output、ログ、監査記録を保存
```

Git に新しい commit が追加されても、自動では反映しません。Takosumi は新しい差分が
あることを示し、次の plan と apply は改めて実行します。

詳しくは [Source と Capsule](./sources.md) と
[実行モデル](./run-model.md)を参照してください。

## provider を使う

必要なサービスは、Git module が宣言する OpenTofu / Terraform provider で管理します。
Cloudflare、AWS、Kubernetes、Takoform などはすべて通常の provider です。Takosumi は
provider の接続情報を ProviderConnection / ProviderBinding から Run の間だけ runner に
渡し、provider の state と実体は provider 側の契約に任せます。

以前の Resource Shape / Form Host 経路は supported product ではありません。残る
Resource API、schema、TargetPool、SpacePolicy は既存データを移行するための temporary
migration internals です。[Resource の移行メモ](./resources.md) はこの扱いを説明します。

## デプロイしたものをつなぐ

module は、接続先 URL や識別子などの非 secret 値を **Output** として
公開できます。別のデプロイから使う場合は、値の出どころと利用許可を Takosumi に
記録します。

Takosumi では、デプロイしたものが提供する接続方法の説明を **Interface**、利用を
許可する記録を **InterfaceBinding** と呼びます。Interface を作っただけではアクセス
権限は増えません。

詳しくは [状態と Output](./state-and-outputs.md) と
[Interface](./interfaces.md)を参照してください。

## 変わらない安全上のルール

- secret の値は API から読み戻せず、Output やログにも載せません
- apply の前に plan を作り、確認した計画を使います
- Git の ref は実行前に commit へ固定します
- provider の state と credential は Run の境界で分離します
- Interface を宣言しただけでは InterfaceBinding の認可は増えません

## ソフトウェアと運用サービス

このドキュメントは Takosumi OSS の共通動作を説明します。hosted Form instance、
保存容量、料金、SLA は endpoint の運用者が決めます。公式ホスティング固有の内容は
Takosumi hosted service のドキュメントに分けています。

[製品の境界](./boundaries.md)で、どこまでがソフトウェアの責任かを確認できます。
