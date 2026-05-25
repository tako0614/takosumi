# コンセプト {#concepts}

## Takosumi とは

Takosumi は `.takosumi.yml` という manifest (宣言ファイル) を読んで、アプリを丸ごとデプロイする PaaS です。
Docker Compose に似ていますが、大きな違いが 1 つあります。manifest には「何が必要か」だけを書き、「どこで動かすか」は書きません。
実行先は operator (運用者) が決めるので、同じ manifest が Cloudflare でも AWS でも動きます。

## manifest の中身

```yaml
# .takosumi.yml
apiVersion: v1
metadata:
  name: my-app
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
  db:
    kind: postgres
    spec:
      version: "16"
```

| キー        | 意味                                                       |
| ----------- | ---------------------------------------------------------- |
| `component` | アプリを構成する個々のパーツ。上の例では `web` と `db` の 2 つ |
| `kind`      | パーツの種類。`worker` はプログラムの実行環境、`postgres` はデータベース |
| `spec`      | その kind に固有の設定。worker なら `entrypoint`、postgres なら `version` |

## publish / listen で接続する {#publish-listen}

component 同士は publish (公開) と listen (受け取り) で接続します。

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
    publish:
      connection: {}

  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    listen:
      db:
        from: db.connection
        prefix: DB
```

`db` が `connection` を publish し、`web` がそれを listen しています。

実際に起こること: `web` の worker に以下の環境変数が注入されます。

```
DB_HOST=...
DB_PORT=5432
DB_USER=...
DB_PASSWORD=...
```

`prefix: DB` が環境変数名の先頭に付きます。コードからは普通の環境変数として読めます。

## Installation と Deployment {#installation-deployment}

manifest をデプロイすると、2 つのレコードが作られます。

| 概念                            | 役割                                     |
| ------------------------------- | ---------------------------------------- |
| Installation (インストール記録)  | Space (デプロイ先のグループ) に紐づく管理レコード。1 つの manifest に 1 つ |
| Deployment (デプロイ履歴)        | apply (適用) するたびに 1 件ずつ増える履歴レコード |

1 つの Installation に何度もデプロイでき、各 Deployment が履歴として残ります。ロールバックは過去の成功した Deployment に戻す操作です。

```text
manifest
  -> Installation を作成
  -> Deployment #1 (初回)
  -> Deployment #2 (コード更新)
  -> Deployment #3 (設定変更)
  -> ロールバック → Deployment #2 に戻す
```

デプロイは Installer API (5 つの HTTP エンドポイント) を通して行います。CLI・GitHub Actions・自前スクリプトのどれからでも同じ API を叩けます。

## 次に読む {#next}

- [クイックスタート](./quickstart.md) -- 実際にデプロイしてみる
- [Manifest リファレンス](../reference/manifest.md) -- 全フィールドの詳細
- [読む順序](./reading-paths.md) -- 目的別のおすすめ順路
