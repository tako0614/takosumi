# Version Alignment

> このページでわかること: Takosumi packages の current version alignment。

pre-GA の public docs では、production 向けの移行手順や rollback 手順を公開
runbook として固定しません。このページは package 間の current alignment と、
release-specific operator runbook が満たすべき不変条件だけを記録します。

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

pre-GA の package bump は release-specific private runbook と検証済み evidence
で扱います。public docs には production 操作手順を固定しません。

---

## Schema ledger invariants

kernel の SQL state は `storage_migrations` ledger で管理されます。production
への適用・rollback command sequence は release-specific operator runbook
に閉じ、 public docs には固定手順として置きません。ここでは ledger
の不変条件だけを 公開します。

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

| check                            | command / source                                    |
| -------------------------------- | --------------------------------------------------- |
| package versions                 | `deno info jsr:@takos/takosumi-kernel`              |
| runtime-agent reported version   | runtime-agent health endpoint / startup log         |
| kernel public API smoke          | `takosumi deploy <manifest> --remote ... --dry-run` |
| schema ledger state              | release-specific operator evidence                  |
| provider live smoke when enabled | provider-specific live provisioning task            |

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

- [CLI Reference](/reference/cli) — current CLI command surface
- [Self-host Notes](/operator/self-host) — production 配信前の checklist
- [Operator Bootstrap](/operator/bootstrap) — provider 配線手順
