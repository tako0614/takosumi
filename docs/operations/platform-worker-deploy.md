# Takosumi platform worker (app.takosumi.com) デプロイ手順

operator が運用する唯一の worker。Takos product は公式にはどこにもデプロイしない
（ユーザーが Takosumi で自分のインフラに deploy する。`takos/deploy/cloudflare/wrangler.toml`
は self-host 用 template であり、operator はこれをデプロイしない）。

## 構成

- worker 名: `takosumi` / custom domain: `app.takosumi.com`（DNS/TLS は deploy が自動管理）
- entry: `takosumi/deploy/platform/worker.ts`（accounts plane + in-process deploy-control + DO ×2）
- config: `takosumi/deploy/platform/wrangler.toml`（相対パスは config dir 基準）
- dashboard SPA: `takosumi/dashboard/`（vite + solid）→ `dist/` を ASSETS で配信
- D1: `takosumi-accounts`（schema は accounts migrate-d1 runner が適用、handler は drift で fail-close）
  / `takosumi-deploy`（テーブル自己作成）
- R2: `takosumi-accounts-exports` / `takos-artifacts`
- queues (producer のみ): `takosumi-control-plane` / `takosumi-opentofu-runs`
- container: `TakosumiOpenTofuRunner`（`takosumi/deploy/cloudflare/runner/Dockerfile`、docker 必須）

## デプロイ

```bash
# 1. dashboard SPA を build
cd takosumi/dashboard && bun install && bun run build

# 2. dry-run → deploy（docker が動いていること）
cd ../  # takosumi root
bunx wrangler deploy --dry-run --config deploy/platform/wrangler.toml
bunx wrangler deploy --config deploy/platform/wrangler.toml
```

## Secrets

値は operator host 上の repo 外ディレクトリ `/root/.takos-secrets/production/`
（staging は `/root/.takos-secrets/staging/`）に 1 ファイル 1 鍵で保管する。
push は bulk JSON を一時生成して `wrangler secret bulk` し、JSON は即削除する。

鍵生成は `takos/scripts/generate-platform-keys.ts` で行う（product self-host 用の
signing key を生成する script で、platform worker 自身が必要とする 7 鍵もここから生成できる）。

必須 7 鍵: `TAKOSUMI_ACCOUNTS_ES256_PRIVATE_JWK` / `TAKOSUMI_ACCOUNTS_ES256_KEY_ID` /
`TAKOSUMI_ACCOUNTS_OIDC_PAIRWISE_SUBJECT_SECRET` / `TAKOSUMI_ACCOUNTS_LAUNCH_TOKEN_PAIRWISE_SECRET` /
`TAKOSUMI_ACCOUNTS_EXPORT_DOWNLOAD_SECRET` / `TAKOSUMI_ACCOUNTS_DEPLOY_CONTROL_TOKEN` /
`TAKOSUMI_DEPLOY_CONTROL_TOKEN`（最後の 2 つは同一値 — accounts→deploy-control の in-process handshake）。

未設定（運用 TODO）: `TAKOSUMI_ACCOUNTS_UPSTREAM_GITHUB_*` / `TAKOSUMI_ACCOUNTS_UPSTREAM_GOOGLE_*`
（upstream OAuth app を登録して push するまで sign-in に使える provider が出ない）、Stripe、passkey。

## 動作確認

```bash
curl -s https://app.takosumi.com/healthz
curl -s https://app.takosumi.com/.well-known/openid-configuration | head -c 200  # issuer = bare origin
curl -s -o /dev/null -w "%{http_code}" https://app.takosumi.com/oauth/jwks       # 200
curl -s -o /dev/null -w "%{http_code}" https://app.takosumi.com/                 # 200 (dashboard SPA)
curl -s -o /dev/null -w "%{http_code}" https://app.takosumi.com/v1/installations # 401
```

## 公開ゲート

`TAKOSUMI_ACCOUNTS_MANAGED_OFFERING_ACCESS = "closed"`（wrangler.toml の vars）の間、`/start` は
`launch_readiness_not_complete` の 503 を返す。公開時にこの var を変更して再デプロイ。
