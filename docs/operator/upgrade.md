# Upgrade

operator が takosumi の version を bump するときに参照する runbook です。

---

## Version policy

Takosumi は **6 つの package** を JSR で独立に publish します。 各 package
はまだ pre-1.0 で、minor bump も breaking change を含む可能性があります。

| Package                         | 最新の方向                                   |
| ------------------------------- | -------------------------------------------- |
| `@takos/takosumi-contract`      | 型契約 (semver、SemVer 適用)                 |
| `@takos/takosumi-kernel`        | HTTP server + apply pipeline + storage       |
| `@takos/takosumi-runtime-agent` | cloud connector / OS connector               |
| `@takos/takosumi-plugins`       | shape catalog + provider plugins + templates |
| `@takos/takosumi-cli`           | `takosumi` コマンド                          |
| `@takos/takosumi`               | 上記 5 つの umbrella                         |

::: warning pre-1.0 0.x の minor bump (`0.10 → 0.11 → 0.12 → 0.13`) は breaking
change を 含み得ます。 必ず
[`CHANGELOG.md`](https://github.com/tako0614/takosumi/blob/master/CHANGELOG.md)
の該当 minor entry を読んでから bump してください。 :::

---

## Upgrade order

依存方向は `contract → runtime-agent → kernel → plugins → cli → umbrella`。
operator が触るのは概ね **kernel + runtime-agent + cli** の 3 つです。

```
┌─ contract ─────────────────────────────────────────┐
│  upgrade order:                                     │
│   1. contract  (型契約; 新 contract 出てから bump)   │
│   2. runtime-agent + kernel                         │
│      ※ 必ず同 minor まで揃える                       │
│   3. plugins                                        │
│   4. cli                                            │
│   5. umbrella (@takos/takosumi)                     │
└─────────────────────────────────────────────────────┘
```

::: warning kernel と agent の version skew kernel ↔ runtime-agent の version
skew は **同 minor まで** 互換保証されます。 別 minor を混ぜると lifecycle
envelope の field 差異で 4xx が返る可能性が あります。 kernel を 0.12
に上げるなら runtime-agent も同タイミングで 0.7 (kernel 0.12 と互換)
に揃えてください。 :::

---

## DB migration runbook

kernel の SQL state は `storage_migrations` ledger で管理されます。 migration の
apply / rollback には kernel package の deno task を使います。

```bash
cd packages/kernel

# 0. plan を確認 (今 ledger に何が applied / pending か)
deno task db:migrate --dry-run

# 1. apply (production: pre-prod でも必ず dry-run 後)
deno task db:migrate                          # local (in-memory)
deno task db:migrate --env=staging            # $TAKOSUMI_STAGING_DATABASE_URL or $DATABASE_URL
deno task db:migrate --env=production         # $TAKOSUMI_PRODUCTION_DATABASE_URL or $DATABASE_URL

# 2. rollback (1 step、down clause が定義された migration のみ)
deno task db:migrate:down                              # 最新 1 個を rollback
deno task db:migrate:down --steps=2                    # 直近 2 個
deno task db:migrate:down --target=<version>           # version > <version> の全部
deno task db:migrate:down --dry-run                    # plan only
```

::: warning production rollback gate `db:migrate:down --env=production` は
**opt-in が必要** です:

- `--allow-production-rollback` flag が必須
- 対話実行時は `ROLLBACK` を typing して確認
- 非対話実行時は `--confirm=ROLLBACK` を渡す

operator が誤って `db:migrate:down` を CI から叩いて production schema を
壊さないようにするためのガードです。 :::

### Checksum / forward-only

各 migration entry には:

- **id** (`<domain>.<seq>.<description>`)
- **version** (整数、catalog 順)
- **checksum** (SHA-256 hex digest of the migration body + down clause)
- **down clause** (optional; 無い migration は forward-only)

が記録されます。 既に applied な migration の SQL を後から修正すると、 runner
が起動時に `StorageMigrationChecksumMismatchError` を投げて拒否 します。 これは
migration の immutability を強制する設計で、修正したい 場合は **新しい migration
entry を追加** してください。

`down` clause が定義されていない migration は **forward-only** で、
`db:migrate:down` がそこに到達した時点で `StorageMigrationDownNotSupportedError`
を投げて停止します。 実装側は
[`packages/kernel/src/adapters/storage/migrations.ts`](https://github.com/tako0614/takosumi/blob/master/packages/kernel/src/adapters/storage/migrations.ts)
で各 migration の `down:` field を確認できます。

---

## Common upgrade pitfalls

### 1. `provider:` の bare id deprecation

0.10 以降、bundled provider id は **`@takos/<cloud>-<service>`** namespacing
に統一されました。 旧 bare id (`aws-fargate`, `cloud-run`, `route53` 等) は 0.10
/ 0.11 で deprecation warning と共に受け付けますが、 0.12 以降での
削除が予告されています。

| 旧 (deprecated)         | 新 (recommended)               |
| ----------------------- | ------------------------------ |
| `aws-fargate`           | `@takos/aws-fargate`           |
| `aws-rds`               | `@takos/aws-rds`               |
| `aws-s3`                | `@takos/aws-s3`                |
| `route53`               | `@takos/aws-route53`           |
| `cloud-run`             | `@takos/gcp-cloud-run`         |
| `cloud-sql`             | `@takos/gcp-cloud-sql`         |
| `gcp-gcs`               | `@takos/gcp-gcs`               |
| `cloud-dns`             | `@takos/gcp-cloud-dns`         |
| `cloudflare-r2`         | `@takos/cloudflare-r2`         |
| `cloudflare-container`  | `@takos/cloudflare-container`  |
| `k3s-deployment`        | `@takos/kubernetes-deployment` |
| `local-docker-postgres` | `@takos/selfhost-postgres`     |
| `systemd-unit`          | `@takos/selfhost-systemd`      |

完全な mapping は
[Quickstart § Deprecated provider IDs](/getting-started/quickstart#deprecated-provider-ids)
を参照。 manifest の `provider:` を新形式に書き換えれば warning は消えます。

### 2. CLI env alias deprecation

CLI の remote 接続 env も renaming されています:

| 旧 (deprecated)       | 新 (recommended)        | 適用                                |
| --------------------- | ----------------------- | ----------------------------------- |
| `TAKOSUMI_KERNEL_URL` | `TAKOSUMI_REMOTE_URL`   | `takosumi deploy --remote` の既定値 |
| `TAKOSUMI_TOKEN`      | `TAKOSUMI_DEPLOY_TOKEN` | `--token` の既定値                  |

`TAKOSUMI_KERNEL_URL` はまだ受け付けますが CLI が次の warning を吐きます:

```
[takosumi] TAKOSUMI_KERNEL_URL is deprecated; use TAKOSUMI_REMOTE_URL
```

新 env への switch を推奨。 詳細は [Environment Variables](/reference/env-vars)
を参照。

### 3. Internal HMAC secret env rename

Internal control plane の HMAC secret は reference 名を
`TAKOSUMI_INTERNAL_API_SECRET` に統一しています。
`TAKOSUMI_INTERNAL_SERVICE_SECRET` は compatibility alias としてまだ読めますが、
両方が設定されている場合は `TAKOSUMI_INTERNAL_API_SECRET` が優先されます。
upgrade 時は operator-managed dashboard / automation / runtime-agent signing
config を新 env に寄せてください。

### 4. kernel ↔ runtime-agent の version skew

| 状態                         | 互換性                     |
| ---------------------------- | -------------------------- |
| kernel 0.12 + agent 0.7      | OK (released together)     |
| kernel 0.12 + agent 0.6      | OK (within same minor era) |
| kernel 0.12 + agent 0.5 以下 | **保証なし**、要 bump      |
| kernel 0.10 + agent 0.7      | **保証なし**、要 bump      |

production では kernel と agent を **同 release バンドル** で揃えるのが
最も安全です。
[`CHANGELOG.md`](https://github.com/tako0614/takosumi/blob/master/CHANGELOG.md)
の `takosumi-kernel` / `takosumi-runtime-agent` 該当バージョンの release
日が同じなら同バンドル扱いにできます。

### 5. selfhost connector の `describe()` 挙動変化

takosumi-runtime-agent **0.7.0** 以降、selfhost connector の `describe()` は
`docker inspect` / `systemctl is-active` を直接 query するように変わりました。
0.6 以前は agent restart 後に `missing` を返していたため、deploy script で
restart→describe をループしているコードがある場合は、新挙動 (live state を 返す)
を前提に再検証してください。 詳細は
[Self-host Notes § Selfhost connector の restart-survival](/operator/self-host#selfhost-connector-の-restart-survival)。

---

## CHANGELOG link

各 package の minor 単位の変更点は CHANGELOG にまとまっています:

- [CHANGELOG.md](https://github.com/tako0614/takosumi/blob/master/CHANGELOG.md)

upgrade 前にかならず該当 minor の entry を確認してください。 大きな behavior
変更には breaking note が直接書かれています。

---

## 関連ページ

- [CLI Reference](/reference/cli) — `db:migrate` / `db:migrate:down` /
  全コマンド
- [Environment Variables](/reference/env-vars) — `TAKOSUMI_*` 全一覧 (deprecated
  含む)
- [Self-host Notes](/operator/self-host) — production 配信前の checklist
- [Operator Bootstrap](/operator/bootstrap) — provider 配線手順
