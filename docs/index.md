# Takosumi

Takosumi は、Git に置いた OpenTofu / Terraform module を、**計画 → 確認 → 反映**の
順で実行する管理サーバーです。実行した commit、変更内容、state、output、実行者を
あとから追える形で保存します。

module や provider はそのまま使います。Takosumi 専用の設定言語はありません。
Takosumi は first-party Terraform/OpenTofu provider を同梱しません。

## Takosumi を使う理由

### 確認した変更だけを反映する

Takosumi は `plan` と `apply` を 1 つの Run として扱います。確認後に別の計画を
作り直さないため、読んだ差分と実際に反映する差分を一致させられます。

### 認証情報を module から分離する

クラウドの API key や token は Takosumi に保存します。値は読み戻せず、必要な Run
の実行中だけ runner に渡されます。同じ module を開発用と本番用で使い、接続だけを
切り替えられます。

### 実行の履歴を残す

どの Git commit を誰が実行し、何が変わったかを記録します。適用ごとに state と output
を保存するため、障害の調査や以前の状態との比較ができます。

## 1 つの Git/OpenTofu flow

登録した Git module を Takosumi は **Capsule** と呼びます。利用者が用意するのは Git
URL、ref、module path、変数、そして module が宣言する provider の接続です。Run、state、
output、監査記録はこの 1 つの Stack flow に集約されます。

```text
Git URL と module の宣言
  → 入力と接続を確認
  → plan
  → 差分を確認
  → apply
  → state・output・監査記録を保存
```

## 最初に試す

API だけなら 5 分で起動できます。データはメモリ上に置かれるため、開発用です。

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install

TAKOSUMI_DEV_MODE=1 \
TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token \
PORT=8788 \
bun core/index.ts
```

別のターミナルから確認します。

```bash
curl http://127.0.0.1:8788/v1/capabilities \
  -H "authorization: Bearer dev-token"
```

dashboard、サインイン、永続データベース、OpenTofu runner を含む環境は
[クイックスタート](./getting-started/quickstart.md)で起動できます。

## 次に読むもの

- [全体像](./concepts/index.md) — 最小限の用語と、デプロイが進む順序
- [Source と Capsule](./concepts/sources.md) — Git の ref を commit に固定する方法
- [実行モデル](./concepts/run-model.md) — plan、承認、apply、destroy
- [認証情報](./concepts/credentials.md) — provider に接続を渡す方法
- [Interface](./concepts/interfaces.md) — デプロイの接続方法と利用許可
- [自分で動かす](./concepts/self-host.md) — production を運用するための構成
- [Repository manifest](./reference/repository-manifest.md) /
  [Store API](./reference/store-api.md) /
  [API](./reference/api.md) / [CLI](./reference/cli.md) /
  [設定](./reference/configuration.md)

旧 Resource Shape / Form Host API の資料は [Resource の移行メモ](./concepts/resources.md)
にまとめています。新しい authoring surface ではありません。

公式ホスティングの料金、hosted service、サポートは
[Takosumi Cloud のドキュメント](https://app.takosumi.com/docs/)にあります。
