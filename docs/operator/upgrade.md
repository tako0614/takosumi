# バージョン整合 {#version-alignment}

::: info
内部設計メモ public contract は [Installer API](../reference/installer-api.md) を参照。[Operator Overview](./index.md) から始めてください。
:::

このページは version alignment invariants を記録します。exact production upgrade commands は release-specific operator runbook に置きます。

---

## バージョンポリシー {#version-policy}

reference Takosumi publish layout は **core/runtime/tooling 6 package (`@takos/takosumi` umbrella を含む) + official catalog/helper 1 package + provider 6 別 package = 計 13 package** です。provider packages、 runtime-agent、official catalog/helper package は release-bundle alignment の対象であり、 Takosumi public conformance surface は Manifest / Installation / Deployment と [Installer API](../reference/installer-api.md) です。 **各 package はまだ pre-1.0 で、 minor bump も breaking change を含む可能性があります。** upgrade 前に必ず CHANGELOG を確認してください。

### Core/runtime/tooling and reference helper (publish order)

下表は AGENTS.md と release script に記録された publish 順 (= contract → installer → runtime-agent → plugins → provider packages → kernel → cli → umbrella) と同期している。`@takos/takosumi-plugins` は official catalog/helper package であり、core Manifest / Installer API conformance surface ではありません。

| Package                         | 最新の方向                                                       |
| ------------------------------- | ---------------------------------------------------------------- |
| `@takos/takosumi-contract`      | 型契約 (semver、SemVer 適用)                                     |
| `@takos/takosumi-installer`     | `.takosumi.yml` parser + git fetch + deploy client               |
| `@takos/takosumi-runtime-agent` | cloud connector / OS connector                                   |
| `@takos/takosumi-plugins`       | official catalog helpers + reference adapter helpers             |
| `@takos/takosumi-kernel`        | HTTP server + apply pipeline + storage                           |
| `@takos/takosumi-cli`           | `takosumi` コマンド                                              |
| `@takos/takosumi`               | 上記 packages の umbrella (cloud provider packages は別 install) |

### Cloud provider (別 install)

operator は必要な cloud だけを別 install する。 6 packages すべて pre-1.0 で運用される。

| Package                                 | 最新の方向                                   |
| --------------------------------------- | -------------------------------------------- |
| `@takos/takosumi-cloudflare-providers`  | Cloudflare (Workers / R2 / DNS) factories    |
| `@takos/takosumi-aws-providers`         | AWS (Fargate / S3 / RDS / Route53) factories |
| `@takos/takosumi-gcp-providers`         | GCP (Cloud Run / GCS / Cloud SQL) factories  |
| `@takos/takosumi-kubernetes-providers`  | Kubernetes Deployment + Service factory      |
| `@takos/takosumi-deno-deploy-providers` | Deno Deploy factory                          |
| `@takos/takosumi-selfhost-providers`    | Self-host (docker / systemd / filesystem) 用 |

Package bump は release-specific operator runbook と検証済み evidence で扱う。

---

## Upgrade 時のダウンタイム {#upgrade-downtime}

Takosumi は schema migration を `takosumi server` 起動時に自動実行します。 schema change を伴う upgrade では Takosumi を一度停止し、新 version の Takosumi を起動する必要があります（rolling upgrade は未サポート）。migration は forward-only のため、rollback が必要な場合は DB snapshot からの復元になります。

---

## スキーマ ledger 不変条件 {#schema-ledger-invariants}

Takosumi の SQL state は `storage_migrations` ledger で管理される。 production への適用・rollback command sequence は release-specific operator runbook に閉じ、 public docs には ledger の不変条件だけを置く。

### チェックサム / forward-only {#checksum--forward-only}

各 migration entry には次が記録される:

- **id** (`<domain>.<seq>.<description>`)
- **version** (整数、apply 順)
- **checksum** (SHA-256 hex digest of the migration body + down clause)
- **down clause** (optional; 無い migration は forward-only)

既に applied な migration の SQL を後から修正すると、 runner が起動時に `StorageMigrationChecksumMismatchError` を投げて拒否する。これは migration の immutability を強制する設計で、修正したい場合は新しい migration entry を追加すること。

`down` clause が定義されていない migration は **forward-only** で、 `db:migrate:down` がそこに到達した時点で `StorageMigrationDownNotSupportedError` を投げて停止する。実装側は `packages/kernel/src/adapters/storage/migrations.ts` で各 migration の `down:` field を確認できる。

---

## ランタイムのバージョン整合 {#runtime-version-alignment}

production では Takosumi と runtime-agent を同じ release bundle から更新する。 `@takos/takosumi-kernel` / `@takos/takosumi-runtime-agent` / `@takos/takosumi-cli` を個別に bump する場合も、 release note の同じ bundle で検証された組み合わせを採用すること。

| check                            | command / source                                   |
| -------------------------------- | -------------------------------------------------- |
| package versions                 | `deno info jsr:@takos/takosumi-kernel`             |
| runtime-agent reported version   | runtime-agent health endpoint / startup log        |
| Takosumi public API smoke        | `takosumi install dry-run --source . --remote ...` |
| schema ledger state              | release-specific operator evidence                 |
| provider live smoke when enabled | provider-specific live provisioning task           |

self-host connector behavior は [セルフホスト運用](./self-host.md) を production traffic 移行前に検証すること。

---

## CHANGELOG リンク {#changelog-link}

各 package の minor 単位の変更点は repository root の CHANGELOG にまとまっている。

upgrade 前に該当 minor の entry を必ず確認すること。大きな behavior 変更には breaking note が直接書かれている。

---

## 関連ページ

- [CLI Reference](../reference/cli.md) — current CLI command surface
- [セルフホスト運用](./self-host.md) — production 配信前の checklist
- [Operator Bootstrap](./bootstrap.md) — provider 配線手順
