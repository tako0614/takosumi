# コンセプト {#concepts}

## Takosumi とは

Takosumi は `.takosumi.yml` という manifest (宣言ファイル) を読んで、アプリを丸ごとデプロイする PaaS です。

Docker Compose に似ていますが、大きな違いが 1 つあります。manifest には「何が必要か」だけを書き、「どこで動かすか」は書きません。実行先は operator (運用者) が決めるので、同じ manifest が Cloudflare でも AWS でも動きます。

## manifest の中身

```yaml
# .takosumi.yml
apiVersion: v1
metadata:
  id: com.example.my-app
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

| キー         | 意味                                                                      |
| ------------ | ------------------------------------------------------------------------- |
| `components` | アプリを構成する個々のパーツ。上の例では `web` と `db` の 2 つ            |
| `kind`       | component が使う定義。`worker` は実行環境、`postgres` はデータベース      |
| `spec`       | その kind に固有の設定。worker なら `entrypoint`、postgres なら `version` |

## connect で component を接続する {#connect-components}

component 同士は `connect` で接続します。

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"

  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    connect:
      db:
        output: db.connection
        inject: env
        prefix: DB
```

`web` が `db.connection` output を受け取ります。

この接続の結果、`web` の worker には以下の環境変数が自動的に渡されます。

```
DB_HOST=...
DB_PORT=5432
DB_USER=...
DB_PASSWORD=...
```

`prefix: DB` の値が環境変数名の先頭に付きます。worker のコードからは通常の環境変数として参照できます。

manifest 外の operator service を使う場合、確定した 1 つの対象は
`listen.path` を使います。

```yaml
listen:
  identity:
    path: identity.primary.oidc
    inject: secret-env
    prefix: IDENTITY
```

MCP server のように Space 内に複数存在してよい対象は、path を指定せず
`listen.kind` と `many: true` でまとめて受け取れます。

```yaml
listen:
  tools:
    kind: mcp-server@v1
    many: true
    inject: config-mount
```

`path` は 1 つの対象を名指しします。同じ Space の同じ path は active provider
を 1 つだけ持てます。`kind` は selector で、component でも publication でも同じ
field 名を使います。manifest には別の `type` selector はありません。

## Installation と Deployment {#installation-deployment}

manifest をデプロイすると、2 つのレコードが作られます。

| 概念                            | 役割                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------- |
| Installation (インストール記録) | Space (デプロイ先のグループ) に紐づく管理レコード。manifest 1 つに対して 1 つ作られる |
| Deployment (デプロイ履歴)       | apply (適用) するたびに 1 件ずつ増える履歴レコード                                    |

1 つの Installation に何度もデプロイでき、各 Deployment が履歴として残ります。ロールバックは過去の成功した Deployment に戻す操作です。

```text
manifest
  -> Installation を作成
  -> Deployment #1 (初回)
  -> Deployment #2 (コード更新)
  -> Deployment #3 (設定変更)
  -> ロールバック → Deployment #2 に戻す
```

デプロイは Installer API (5 つの HTTP エンドポイント) を通して行います。CLI、GitHub Actions、自前スクリプトのいずれからでも同じ API を呼び出せます。

## 次に読む {#next}

- [クイックスタート](./quickstart.md) -- 実際にデプロイしてみる
- [Manifest リファレンス](../reference/manifest.md) -- 全フィールドの詳細
- [読む順序](./reading-paths.md) -- 目的別のおすすめ順路
