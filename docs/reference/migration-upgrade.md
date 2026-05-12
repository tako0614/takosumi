# Migration / Upgrade

> Stability: stable Audience: operator See also: [CLI](/reference/cli),
> [Environment Variables](/reference/env-vars),
> [Cross-Process Locks](/reference/cross-process-locks),
> [Audit Events](/reference/audit-events),
> [Readiness Probes](/reference/readiness-probes),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Closed Enums](/reference/closed-enums)

Takosumi v1 における migration と upgrade の正式仕様。kernel version の rolling
upgrade、schema migration の up / down semantics、rollback gate、 kernel ↔
runtime-agent skew tolerance、runtime-agent drain protocol、 operator workflow
までを定義する。

## Kernel version upgrade path

kernel pod の upgrade は **rolling upgrade** を default とする。1 pod ずつ
SIGTERM → graceful drain → restart で進める。

| Upgrade scope     | downtime          | constraint                                           |
| ----------------- | ----------------- | ---------------------------------------------------- |
| patch (z)         | zero              | schema 互換維持。skew tolerance 内で運用継続         |
| same minor (y.z)  | zero              | schema 互換維持。並走中に旧 / 新 kernel が共存して可 |
| cross minor (x.y) | read-only window  | schema migration が走る間 mutation を pause          |
| major (x)         | non-zero downtime | manual playbook 必要 (本 reference の対象外)         |

rolling upgrade 中の kernel pod 群は `cross-process locks`
([Cross-Process Locks](/reference/cross-process-locks)) を共有することで
直列化される。schema 不整合が発生する upgrade は後述の rollback gate に よって
rejection される。

### Graceful drain

kernel pod は SIGTERM を受け取ると以下を行う。

1. `/readyz` を 503 に切り替え (load balancer から外れる)
2. 現在 hold している lock を release できる operation は release
3. in-flight `apply` / `activate` / `destroy` / `rollback` は WAL stage の
   切れ目まで進めて停止 (heartbeat は最後まで打つ)
4. observation worker / log worker は work queue を flush
5. 全 worker idle で kernel exit (`0`)

drain timeout は default `60s`。超過は `SIGKILL` で強制終了し、recovery
経路に渡す ([Lifecycle](/reference/lifecycle))。

## Schema migration

kernel boot 時に schema version を確認し、必要に応じて migration を実行する。

### Version vector

schema version は `(major, minor)` の 2-tuple。kernel は以下を持つ:

- `code-required`: 当該 kernel binary が要求する schema version
- `code-supported-range`: kernel が読める schema version の closed range
  (`[low, high]`、両端含む)
- `db-current`: SQL store に書き込まれた現 schema version

不変条件: `db-current` ∈ `code-supported-range` でなければ kernel boot を
fail-closed する (`schema_incompatible`)。

### Up migration

up migration の規約:

- **idempotent**: 同 migration を二度走らせても副作用が増えない
- **transactional**: `BEGIN; ... COMMIT;` で wrap し、途中失敗で partial state
  を残さない (DDL を含む store では migration ごとに savepoint を切る)
- **forward-compatible**: schema 変更後も `code-supported-range.low` 以下の
  kernel が引き続き起動できる場合のみ minor bump 内で許される

migration は `takosumi migrate` (CLI、[CLI](/reference/cli)) または kernel
自身が起動時に自動実行する。kernel 自動実行は env `TAKOSUMI_MIGRATE_ON_BOOT=1`
を要する (default off)。

### Down migration

down migration は **同 minor 内のみ** 保証する。cross-minor の down は
forward-only として扱い、down migration は提供しない (rollback gate が そもそも
cross-minor rollback を reject する)。

down migration の規約:

- 同 minor 内では up と対をなす SQL を提供する
- column drop は data loss を伴う場合があり、その時は CLI が `--allow-data-loss`
  を要求する

### Upgrade maintenance window

cross-minor upgrade の間、kernel は以下を満たす:

- 全 pod を 503 にして mutation 系 endpoint を停止
- `apply` / `activate` / `destroy` / `rollback` は WAL stage の切れ目で停止し
  resume key を WAL に残す
- read 系 endpoint (`status` / `describe` / `observe`) は引き続き 200
- migration 完了後、resume key から in-flight operation を再開

fail-closed する。

## Rollback gate

upgrade 失敗時に旧 binary に戻す場合、kernel は schema version compat range
を宣言することで rollback の可否を判定する。

| State                                                   | rollback                                    |
| ------------------------------------------------------- | ------------------------------------------- |
| `db-current` が old kernel の `code-supported-range` 内 | rollback 可。binary 入れ替えのみ            |
| `db-current` が old kernel の range 外で同 minor        | rollback 前に down migration を要する       |
| `db-current` が old kernel の range 外で cross minor    | rollback 不可 (forward-only invariant 違反) |

new code が `code-required > db-current` のとき、kernel boot は
`schema_required_higher_than_current` で fail-closed する。これにより rollback
gate が **boot 段階で reject** される構造になっている。

operator は rollback 前に必ず:

1. `takosumi migrate --dry-run --env <env>` で pending migration を確認
2. 旧 kernel の `code-supported-range` を release notes / `/version` endpoint
   で確認
3. 必要なら `deno task db:migrate:down --target=<version>` で同 minor 内 down
   を実行
4. 旧 kernel binary に置き換えて rolling restart

## Kernel ↔ runtime-agent skew tolerance

kernel と runtime-agent は **同 major 内 / 最大 2 minor の skew** を許容 する。

Rationale: skew 範囲を 2 minor 以内に縛ることで provider plugin の wire shape
backward-compat 検証を bounded に保つ。3 minor 以上を許すと N×M version pair の
testing matrix が現実的でなくなり、kernel 側 dispatcher が抱える backward-compat
path が線形に増える。2 minor は典型的な monthly release cadence で 2 ヶ月の
operator upgrade window を提供し、運用と検証コストの均衡点を取る。

| Skew            | 許容                                                        |
| --------------- | ----------------------------------------------------------- |
| same minor      | yes                                                         |
| 1 minor         | yes                                                         |
| 2 minor         | yes (boundary 警告のみ)                                     |
| 3 minor 以上    | no — kernel が agent を `agent_skew_out_of_range` で reject |
| different major | no — describe / verify / apply すべて reject                |

skew は kernel が agent enrollment 時 / heartbeat 時に検査する。reject された
agent は registry に乗らず、当該 agent への dispatch は fail-closed される。

operator は skew が 2 minor に達した時点で agent upgrade plan を組むのが
推奨される。3 minor を超えた状態で kernel を上げると agent dispatch が
全停止するため。

## Runtime-Agent upgrade

agent の rolling upgrade は kernel-driven で進める。

1. operator が new agent binary を deploy 環境に配布する (helm / docker /
   systemd 等は本 reference 範囲外)
2. new agent が起動し kernel に enroll を request する
3. kernel は skew check を行い OK なら registry に追加する。skew NG なら reject
   し、operator に通知する
4. operator が `POST /api/internal/v1/runtime/agents/:id/drain` を発行して 既存
   agent を drain mode に切り替える
5. drain mode の agent は新規 lifecycle dispatch を受けず、in-flight だけを
   完走させる
6. agent が idle になったら operator が agent process を停止

drain endpoint の呼び出しは internal control plane 経由で、operator か deploy
automation が呼ぶ。kernel は drain 中の agent を heartbeat 維持の
範囲で監視し、dispatch を別 agent に逃がす。

## CLI 経由の operator workflow

主要 CLI / operator command:

| Command                                      | 用途                                         |
| -------------------------------------------- | -------------------------------------------- |
| `takosumi migrate [--env <env>] [--dry-run]` | DB schema migration を実行                   |
| `deno task db:migrate:down --target=<v>`     | 同 minor 内 down migration (operator script) |
| `deno task db:migrate:down --dry-run`        | down migration plan の確認                   |

remote mode の kernel に対しては operator が deploy automation 側で binary
を入れ替え、kernel pod を rolling restart させる。CLI 単体では remote kernel
binary は触らない。

## Audit events

migration / upgrade 関連の audit event は
[Audit Events](/reference/audit-events) の hash chain に連結される。

| Event name                 | 内容                                                   |
| -------------------------- | ------------------------------------------------------ |
| `migration-started`        | migration 開始時。`from-version` / `to-version` を含む |
| `migration-progress`       | step 単位の進捗 (大規模 migration 用、定期 emit)       |
| `migration-completed`      | 全 step 完了時。`db-current` を確定値で記録            |
| `migration-rollback`       | down migration 実行時。`from-version` / `to-version`   |
| `migration-aborted`        | migration が途中で失敗した場合。失敗 step / error code |
| `kernel-upgrade-started`   | rolling upgrade で先頭 pod が drain 開始した時         |
| `kernel-upgrade-completed` | 全 pod が new binary で steady state に達した時        |
| `agent-skew-rejected`      | enrollment / heartbeat で skew check が reject した時  |

audit event は migration の各 phase で emit され、operator dashboard が tracking
に使う。

## Failure modes

| 状況                                      | error code                     | 復旧                                                                                                                             |
| ----------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `db-current` が `code-supported-range` 外 | `schema_incompatible`          | down migration または kernel binary を戻す                                                                                       |
| migration 途中で kernel crash             | recovery 経路で resume         | operator migration runner を再実行して recovery path に任せる。Current public `takosumi migrate` は `--resume` flag を公開しない |
| agent skew が range 外                    | `agent_skew_out_of_range`      | agent を upgrade して enroll 再試行                                                                                              |
| drain timeout 超過                        | `kernel_drain_timeout`         | `SIGKILL` 後 recovery、operator が原因調査                                                                                       |
| cross-minor rollback で down が無い       | `down_migration_not_supported` | rollback 不可。forward-only で対処                                                                                               |

## Related architecture notes

関連 architecture notes:

- `docs/reference/architecture/operator-boundaries.md` — kernel と runtime-agent
  の trust 境界、skew tolerance の選定 rationale recovery mode の interplay
- `docs/reference/architecture/operational-hardening-checklist.md` — production
  rolling upgrade の運用 checklist
