# 仕組みの全体像

Takosumi はクラウド API の代わりではありません。OpenTofu / Terraform と既存 provider
を実行し、その前後に確認、認可、記録を加えます。

## 最初に覚える 6 つ

| 名前          | 普通の言葉でいうと                                      |
| ------------- | ------------------------------------------------------- |
| **Workspace** | チームと権限を分ける入れ物                              |
| **Project**   | Workspace 内でアプリやインフラを整理する単位            |
| **Source**    | 登録した Git リポジトリと module の場所                 |
| **Capsule**   | Source から作った、1 つの module のデプロイ単位         |
| **Run**       | plan、apply、refresh、destroy など 1 回の実行           |
| **Resource**  | module を自分で書かず、種類と設定を指定して作るサービス |

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

## Resource を作る

Resource は、オブジェクトストレージや SQL データベースのようなサービスを、型と設定で
要求する経路です。

```text
1. endpoint が対応する Resource の種類を確認
2. 欲しい種類と設定を宣言
3. Takosumi が利用可能な配置先と実装を選択
4. plan を確認して apply
5. 実際のサービスの状態と output を保存
```

使える Resource は運用者が決めます。Takosumi OSS は特定クラウドを強制せず、対応する
実装が 0 個でも Git module の経路は使えます。Takoform はこの Resource 宣言を別の
環境でも扱いやすくする形式の 1 つです。

詳しくは [Resource](./resources.md) を参照してください。

## デプロイしたものをつなぐ

module と Resource は、接続先 URL や識別子などの非 secret 値を **Output** として
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
- Resource の配置先を決めたあと、別の実装へ黙って切り替えません
- 読み取り専用の観測で差分が見つかっても、自動適用しません

## ソフトウェアと運用サービス

このドキュメントは Takosumi OSS の共通動作を説明します。利用できる Resource、
保存容量、料金、SLA は endpoint の運用者が決めます。公式ホスティング固有の内容は
Takosumi Cloud のドキュメントに分けています。

[製品の境界](./boundaries.md)で、どこまでがソフトウェアの責任かを確認できます。
