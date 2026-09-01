# バックアップと復旧

守るものは 3 種類です。どれか 1 つでも欠けると、失うものが変わります。

| 何 | どこにあるか | 失うと |
| --- | --- | --- |
| 記録のデータベース | PostgreSQL (compose) / D1 (Cloudflare) | アカウント、Workspace、Run の履歴、Capsule の台帳すべて |
| state と成果物 | `takosumi-runtime` volume (compose) / R2 (Cloudflare) | 適用済みインフラの state。以後の plan / destroy が現実と突き合わせられなくなります |
| 封印鍵 | `TAKOSUMI_SECRET_STORE_PASSPHRASE` ほか `.env` / secret の値 | 保存済みの認証情報と state 封筒が復号できなくなります |

鍵はデータと同じ場所に置かないでください。データベースと volume を完全に
バックアップしていても、封印鍵を失えば中身は開けません。

## Bun と PostgreSQL 構成

データベースは普通の PostgreSQL としてバックアップします。

```bash
docker compose exec postgres pg_dump -U takosumi takosumi_accounts > backup.sql
```

`takosumi-runtime` volume (source archive と封印済み state) も同じ周期で取ります。

```bash
docker run --rm -v node-postgres_takosumi-runtime:/data -v "$PWD":/backup \
  alpine tar czf /backup/takosumi-runtime.tar.gz -C /data .
```

復旧は逆順です。まず `.env` の秘密 (特に `TAKOSUMI_SECRET_STORE_PASSPHRASE`) を
元の値で用意し、PostgreSQL を restore し、volume を書き戻してから
`docker compose up -d` します。

## Cloudflare 構成

D1 は `wrangler d1 export` で SQL を書き出せます。R2 の各 bucket
(`takosumi-state` / `takosumi-source` / `takos-artifacts` / `takosumi-backups`)
は rclone などの S3 互換ツールで複製します。

## 製品自身のバックアップ機能について

dashboard の「バックアップを作成」は、Workspace の記録の一部を封印付きで
書き出すものです。これは Workspace 単位の証跡であって、この
ページで扱うデータベース全体のバックアップの代わりにはなりません。まず
データベースと volume を守り、その上で使ってください。

## 復旧演習

バックアップは、復元して初めてバックアップです。四半期に 1 回は、空の環境に
「秘密 → データベース → volume → 起動 → dashboard でサインイン →
既存サービスの一覧が見える」までを通してください。
