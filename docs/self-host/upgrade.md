# 更新する

Takosumi の更新は「新しいコードに差し替えてから、足りないマイグレーションを足す」の
一方向だけです。データベースのマイグレーションは forward-only で、down や rollback
はありません。コードを前の版に戻すことはできますが、適用済みのスキーマはそのまま
残り、新しい版はそれを前提に動きます。

## Bun と PostgreSQL 構成

```bash
git pull
bun install
bun run build:dashboard
cd deploy/node-postgres
docker compose build
docker compose up -d
```

compose の `migrations` コンテナが accounts 側のマイグレーションを起動前に流します。
control plane 側は checkout から明示的に流します。

```bash
cd ../..
DATABASE_URL="postgres://takosumi:<password>@<postgres-host>:5432/takosumi_accounts" \
  bun run db:migrate --env=production
```

先に `bun run db:migrate:dry-run` を実行すると、適用せずに SQL だけ確認できます。

## Cloudflare 構成

```bash
git pull
bun install
bun run build:dashboard
bun run cli -- accounts migrate-d1 --database-id takosumi-accounts --remote
bunx wrangler deploy --config deploy/platform/wrangler.toml
```

control plane 側の D1 は `TAKOSUMI_CONTROL_D1_SCHEMA_MODE` が既定の `bootstrap` の
あいだ、deploy 後の最初のリクエストで自動的に追い付きます。`predeployed` で運用して
いる場合は、deploy の前にマイグレーションを済ませておく必要があります。

## 戻したくなったら

コードは前の版に戻せます (Cloudflare なら `wrangler versions deploy` で前の
Worker version、compose なら前のイメージ)。ただしスキーマは戻りません。新しい版が
足したテーブルや列は残り、古いコードはそれを無視して動きます。マイグレーションが
additive である限りこれは安全ですが、戻したまま運用を続けるのではなく、原因を
直して前に進むことを前提にしてください。
