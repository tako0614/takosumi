# Schema Evolution Invariants

## Takosumi replacement invariants

Takosumi pod の process replacement は SIGTERM → graceful drain → restart の順で安全に停止できなければならない。

| Change scope      | serving invariant        | constraint                                  |
| ----------------- | ------------------------ | ------------------------------------------- |
| patch (z)         | service-specific         | schema shape は同一                         |
| same minor (y.z)  | service-specific         | schema 追加は supported range 内            |
| cross minor (x.y) | mutation pause invariant | schema change 中は mutation を受け付けない  |
| major (x)         | outside this reference   | release-specific private runbook でのみ扱う |

process replacement 中の kernel pod 群は [Cross-Process Locks](./cross-process-locks.md) を共有することで直列化される。 schema 不整合が発生する process replacement は後述の rollback gate によって rejection される。

### Graceful drain

Takosumi pod は SIGTERM を受け取���と以下を行う。

1. `/readyz` を 503 に切り替え (control-plane load balancer から外れる)
2. 現在 hold している lock を release できる operation は release
3. in-flight `apply` / `activate` / `destroy` / `rollback` は WAL stage の切れ目まで進めて停止 (heartbeat は最後まで打つ)
4. observation worker / log worker は work queue を flush
5. 全 worker idle で process exit (`0`)

drain timeout は default `60s`。超過は `SIGKILL` で強制終了し、 recovery 経路に渡す ([Lifecycle](./lifecycle.md))。

## Schema migration

Takosumi boot 時に schema version を確認し、必要に応じて migration を実行する。

### Version vector

schema version は `(major, minor)` の 2-tuple。 Takosumi は以下を持つ:

- `code-required`: 当該 Takosumi binary が要求す�� schema version
- `code-supported-range`: Takosumi が読める schema version の closed range (`[low, high]`、両端含む)
- `db-current`: SQL store に書き込まれた現 schema version

不変条件: `db-current` ∈ `code-supported-range` でなければ Takosumi boot を fail-closed する (`schema_incompatible`)。

### Up migration

up migration の規約:

- **idempotent**: 同 migration を二度走らせても副作用が増えない
- **transactional**: `BEGIN; ... COMMIT;` で wrap し、途中失敗で partial state を残さない (DDL を含む store では migration ごとに savepoint を切る)
- **forward-compatible**: schema 変更後も `code-supported-range.low` 以下の Takosumi が引き続き起動できる場合のみ minor bump 内で許される

migration は [CLI](./cli.md) (`takosumi migrate`) または Takosumi 自身が起動時に自動実行する。自動実行は env `TAKOSUMI_DB_AUTO_MIGRATE=true` で有効になり、production / staging は default true、local / dev は default false。

### Down migration

down migration は **同 minor 内のみ** 保証する。 cross-minor の down は forward-only として扱い、 down migration は提供しない (rollback gate がそもそも cross-minor rollback を reject する)。

down migration の規約:

- 同 minor 内では up と対をなす SQL を提供する
- column drop は data loss を伴う場合があり、その時は CLI が `--allow-data-loss` を要求する

### Schema-change mutation pause invariant

schema change ���伴う release-private operation の間、 Takosumi は以下を満たす。

- 全 pod を 503 にして mutation 系 endpoint を停止
- `apply` / `activate` / `destroy` / `rollback` は WAL stage の切れ目で停止し resume key を WAL に残す
- read 系 endpoint (`status` / `describe` / `observe`) は引き続き 200
- migration 完了後、 resume key から in-flight operation を再開

fail-closed する。

## Rollback gate

upgrade 失敗時に previous binary に戻す場合、 Takosumi は schema version supported range を宣言することで rollback の可否を判定する。

| State                                                          | rollback                                    |
| -------------------------------------------------------------- | ------------------------------------------- |
| `db-current` が previous Takosumi の `code-supported-range` 内 | rollback 可。binary 入れ替えのみ            |
| `db-current` が previous Takosumi の range 外で同 minor        | rollback 前に down migration を要する       |
| `db-current` が previous Takosumi の range 外で cross minor    | rollback 不可 (forward-only invariant 違反) |

new code が `code-required > db-current` のとき、 Takosumi boot は `schema_required_higher_than_current` で fail-closed する。これにより rollback gate が **boot 段階で reject** される構造になっている。

rollback は release-specific な operator 作業。 public reference は可否判定の invariant だけを定義し、 production 向けの down-migration 手順や operator window は公開しない。必要な操作は対象 release の private runbook と実証済み evidence で扱う。

## Takosumi ↔ runtime-agent version alignment

Takosumi と runtime-agent は **同 major 内 / 最大 2 minor の release-set alignment** だけを current invariant として許容する。

> Rationale: alignment 範囲を 2 minor 以内に縛ることで provider implementation の wire shape 検証を bounded に保つ。 3 minor 以上を許すと N×M version pair の testing matrix が現実的でなくなり、 dispatcher が抱える release-set 分岐が線形に増える。

| Alignment       | 許容                                                          |
| --------------- | ------------------------------------------------------------- |
| same minor      | yes                                                           |
| 1 minor         | yes                                                           |
| 2 minor         | yes (boundary 警告のみ)                                       |
| 3 minor 以上    | no — Takosumi が agent を `agent_skew_out_of_range` で reject |
| different major | no — describe / verify / apply すべて reject                  |

alignment は Takosumi が agent enrollment 時 / heartbeat 時に検査する。 reject された agent は registry に乗らず、当該 agent への dispatch は fail-closed される。

operator 向けの package 更新順は public docs には固定しない。 3 minor を超えた組み合わせは agent dispatch が fail-closed される。

## Runtime-Agent drain invariants

agent process replacement は Takosumi-driven drain を通る。

- new agent が起動し Takosumi に enroll を request する
- Takosumi は alignment check を行い OK なら registry に追加する。 NG なら reject して dispatch 対象にしない
- `POST /api/internal/v1/runtime/agents/:id/drain` は既存 agent を drain mode に切り替える
- drain mode の agent は新規 lifecycle dispatch を受けず、 in-flight だけを完走させる
- idle 後の process 停止は release-specific automation の責任

drain endpoint の呼び出しは internal control plane 経由。 operator か deploy automation が呼ぶ。 Takosumi は drain 中の agent を heartbeat 維持の範囲で監視し、dispatch を別 agent に逃がす。

## Operator workflow boundary

remote mode の Takosumi に対しては operator が deploy automation 側で binary を入れ替える。 CLI 単体では remote Takosumi binary は触らない。 schema evolution の実行コマンドは release ごとの private operator runbook に閉じる。 public reference では current invariant だけを扱う。

## Audit events

migration / upgrade 関連の audit event は [Audit Events](./audit-events.md) の hash chain に連結される。

| Event name                 | 内容                                                   |
| -------------------------- | ------------------------------------------------------ |
| `migration-started`        | migration 開始時。`from-version` / `to-version` を含む |
| `migration-progress`       | step 単位の進捗 (大規模 migration 用、定期 emit)       |
| `migration-completed`      | 全 step 完了時。`db-current` を確定値で記録            |
| `migration-rollback`       | down migration 実行時。`from-version` / `to-version`   |
| `migration-aborted`        | migration が途中で失敗した場合。失敗 step / error code |
| `kernel-upgrade-started`   | process replacement で先頭 pod が drain 開始した時     |
| `kernel-upgrade-completed` | 全 pod が new binary で steady state に達した時        |
| `agent-skew-rejected`      | enrollment / heartbeat で skew check が reject した時  |

audit event は migration の各 phase で emit され、 operator UI が tracking に使う。

## Failure modes

| 状況                                      | error code                     | 復旧                                                                       |
| ----------------------------------------- | ------------------------------ | -------------------------------------------------------------------------- |
| `db-current` が `code-supported-range` 外 | `schema_incompatible`          | release-specific runbook に従って schema / binary を整合させる             |
| migration 途中で kernel crash             | recovery 経路で resume         | recovery path に任せる。Current public CLI は `--resume` flag を公開しない |
| agent skew が range 外                    | `agent_skew_out_of_range`      | current kernel の supported range に合う agent を enroll する              |
| drain timeout 超過                        | `kernel_drain_timeout`         | `SIGKILL` 後 recovery、operator が原因調査                                 |
| cross-minor rollback で down が無い       | `down_migration_not_supported` | rollback 不可。forward-only で対処                                         |

## Related architecture notes

- `docs/reference/architecture/operator-boundaries.md` — Takosumi と runtime-agent の trust 境界、 skew tolerance の選定 rationale recovery mode の interplay
- `docs/reference/architecture/operational-hardening-checklist.md` — production process replacement の private evidence checklist

## 関連ページ

- [CLI](./cli.md)
- [Environment Variables](./env-vars.md)
- [Cross-Process Locks](./cross-process-locks.md)
- [Audit Events](./audit-events.md)
- [Readiness Probes](./readiness-probes.md)
- [Reference Kernel Route Inventory](./kernel-http-api.md)
- [Enum and Value Index](./closed-enums.md)
