# 仕組みの全体像

Takosumi は、module や provider のコードを変えずに OpenTofu / Terraform と既存の provider
を実行し、その前後に確認、認可、記録を加えます。クラウド API の代わりになるものではありません。

## 最初に覚える 6 つ

| 名前          | 普通の言葉でいうと                                                     | dashboard での表示                         |
| ------------- | ---------------------------------------------------------------------- | ------------------------------------------ |
| **Capsule**   | 1 つの module を動かすアプリ。所有者と必要なメンバーで管理する           | **アプリ**                                |
| **Source**    | 登録した Git リポジトリと module の場所                                | 取得元                                     |
| **Run**       | plan、apply、destroy など 1 回の実行                                   | **デプロイ履歴** の 1 件（変更の確認、デプロイなど） |
| **Interface** | デプロイしたものが提供する接続方法の宣言                              | 連携面（上級者向け）。画面を持つものはホームのアプリ |
| **Workspace** | 内部の名前空間と、旧 API・保存データを扱うために残る互換の単位           | 通常のアプリ管理では選択不要                 |
| **Project**   | 既存の Workspace 内を整理する区分                                     | 表示されません                             |

管理する単位はアプリ（Capsule）です。所有者とメンバーは、そのアプリの表示・設定変更・
更新・ロールバックなどを行えます。削除、所有者の譲渡、メンバー管理は所有者だけが行えます
（メンバー本人の離脱は可能です）。アプリを使うだけの人は、アプリ自身の URL とアクセス規則で
利用します。管理メンバーになる必要はありません。

所有記録のあるアプリでは、Workspace のメンバーでなくてもアプリの役割で管理でき、
Workspace の所有者であることだけでは他人のアプリを管理できません。トークンの scope や
対象アプリの制限は引き続き適用されます。古い schema や所有記録の移行途中では、一部の入口に
従来の Workspace 判定が残ります。共有アカウント構成が現在の membership を要求するときも、
アプリの役割と Workspace 判定の両方が必要です。詳しくは [API のアプリ管理の権限](../reference/api.md#アプリ管理の権限)
を参照してください。

Workspace の ID や `handle` は互換 API と既存の保存データに残っています。通常の導入・管理で
Workspace を先に作ったり、選んだりする必要はありません。`production` や `preview` のような
具体的な実行環境は Capsule に属します。

state、output、ログ、監査記録は Run の結果です。provider の API key などは
**Connection**（dashboard では **接続済みアカウント**）として別に保存し、必要な Run にだけ割り当てます。

細かな型名や API 上の名前は[用語集](../reference/glossary.md)にあります。最初から
すべて覚える必要はありません。

## Git module をデプロイする

```text
1. Git URL と ref（必要ならリポジトリ内のディレクトリも）を Source として登録
2. ref を 1 つの commit に固定し、Git が追跡している OpenTofu のファイルを読み取り専用で調べる（scan）
3. scan で見つかった module を選び、Capsule を作成
4. 接続済みアカウント（Connection）と入力変数を割り当て
5. 変更の確認（plan）を実行
6. 差分を確認してデプロイ（apply）
7. state、output、ログ、監査記録を保存
```

Git に新しい commit が追加されても、既定では自動でデプロイしません。Takosumi は新しい
commit があることを示すだけで、次の plan とデプロイは人が始めます。Capsule で自動更新
（`autoUpdate`）を有効にした場合だけ、削除や置き換えがなく、承認や policy の gate にも
かからず、変更されるリソースの一覧が分かっている plan を自動でデプロイします
（[Source と Capsule](./sources.md)）。

詳しくは [Source と Capsule](./sources.md) と
[実行モデル](./run-model.md)を参照してください。

サービスを猶予期間のあとで削除する方法と、取り消し・止まったときの直し方は
[削除の予約](./scheduled-uninstall.md)を参照してください。

## provider を使う

必要なサービスは、Git module が宣言する OpenTofu / Terraform provider で管理します。
Cloudflare、AWS、Kubernetes、Takoform などはすべて通常の provider です。Takosumi は
provider の接続情報を ProviderConnection / ProviderBinding から Run の間だけ runner に
渡し、provider の state と実体は provider 側の契約に任せます。

以前あった Resource Shape / Form Host の仕組みは廃止し、旧 `/v1` HTTP は常に `404` を返します。
既存のデータを扱うための内部の schema と記録、移行専用の処理だけが残っています
（[Resource の移行メモ](./resources.md)）。

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
