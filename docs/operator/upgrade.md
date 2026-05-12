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

## Runtime Version Alignment

production では kernel と runtime-agent を同じ release bundle から更新します。
`@takos/takosumi-kernel`、`@takos/takosumi-runtime-agent`、`@takos/takosumi-cli`
を個別に bump する場合も、release note の同じ bundle で検証された組み合わせを
採用してください。

| check                            | command / source                                      |
| -------------------------------- | ----------------------------------------------------- |
| package versions                 | `deno info jsr:@takos/takosumi-kernel`                |
| runtime-agent reported version   | runtime-agent health endpoint / startup log           |
| kernel public API smoke          | `takosumi deploy <manifest> --remote ... --dry-run`   |
| DB migration state               | `deno task db:migrate --dry-run` in `packages/kernel` |
| provider live smoke when enabled | provider-specific live provisioning task              |

Self-host connector behavior should be validated with
[Self-host Notes](/operator/self-host) before production traffic is moved.

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
- [Self-host Notes](/operator/self-host) — production 配信前の checklist
- [Operator Bootstrap](/operator/bootstrap) — provider 配線手順
