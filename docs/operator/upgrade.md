# Version Alignment

> このページでわかること: Takosumi packages の current version alignment。

Public docs では production 向けの schema-change / rollback 手順を runbook
として固定しない。 ここでは package 間の current alignment と、 release-specific
operator runbook が満たすべき不変条件だけを記録する。

---

## Version policy

Takosumi は **6 つの package** を JSR で独立に publish する。 各 package はまだ
pre-1.0 で、 minor bump も breaking change を含む可能性がある。

| Package                         | 最新の方向                                |
| ------------------------------- | ----------------------------------------- |
| `@takos/takosumi-contract`      | 型契約 (semver、SemVer 適用)              |
| `@takos/takosumi-kernel`        | HTTP server + apply pipeline + storage    |
| `@takos/takosumi-runtime-agent` | cloud connector / OS connector            |
| `@takos/takosumi-plugins`       | component kind catalog + provider plugins |
| `@takos/takosumi-cli`           | `takosumi` コマンド                       |
| `@takos/takosumi`               | 上記 5 つの umbrella                      |

Package bump は release-specific private runbook と検証済み evidence で扱う。

---

## Schema ledger invariants

kernel の SQL state は `storage_migrations` ledger で管理される。 production
への適用・rollback command sequence は release-specific operator runbook
に閉じ、 public docs には ledger の不変条件だけを置く。

### Checksum / forward-only

各 migration entry には次が記録される:

- **id** (`<domain>.<seq>.<description>`)
- **version** (整数、catalog 順)
- **checksum** (SHA-256 hex digest of the migration body + down clause)
- **down clause** (optional; 無い migration は forward-only)

既に applied な migration の SQL を後から修正すると、 runner が起動時に
`StorageMigrationChecksumMismatchError` を投げて拒否する。 これは migration の
immutability を強制する設計で、 修正したい場合は新しい migration entry
を追加すること。

`down` clause が定義されていない migration は **forward-only** で、
`db:migrate:down` がそこに到達した時点で `StorageMigrationDownNotSupportedError`
を投げて停止する。 実装側は
[`packages/kernel/src/adapters/storage/migrations.ts`](https://github.com/tako0614/takosumi/blob/master/packages/kernel/src/adapters/storage/migrations.ts)
で各 migration の `down:` field を確認できる。

---

## Runtime Version Alignment

production では kernel と runtime-agent を同じ release bundle から更新する。
`@takos/takosumi-kernel` / `@takos/takosumi-runtime-agent` /
`@takos/takosumi-cli` を個別に bump する場合も、 release note の同じ bundle
で検証された組み合わせを採用すること。

| check                            | command / source                                    |
| -------------------------------- | --------------------------------------------------- |
| package versions                 | `deno info jsr:@takos/takosumi-kernel`              |
| runtime-agent reported version   | runtime-agent health endpoint / startup log         |
| kernel public API smoke          | `takosumi deploy <manifest> --remote ... --dry-run` |
| schema ledger state              | release-specific operator evidence                  |
| provider live smoke when enabled | provider-specific live provisioning task            |

self-host connector behavior は [Self-host Notes](/operator/self-host) を
production traffic 移行前に検証すること。

---

## CHANGELOG link

各 package の minor 単位の変更点は CHANGELOG にまとまっている:

- [CHANGELOG.md](https://github.com/tako0614/takosumi/blob/master/CHANGELOG.md)

upgrade 前に該当 minor の entry を必ず確認すること。 大きな behavior 変更には
breaking note が直接書かれている。

---

## 関連ページ

- [CLI Reference](/reference/cli) — current CLI command surface
- [Self-host Notes](/operator/self-host) — production 配信前の checklist
- [Operator Bootstrap](/operator/bootstrap) — provider 配線手順
