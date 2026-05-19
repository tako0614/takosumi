# Time / Clock Model

> このページでわかること: kernel の時刻モデルと clock 依存の扱い。

本ページは Takosumi installation での時刻と clock 取り扱いに関する v1 contract
である。 各時刻依存機能の clock source、 pod 間で許容する skew、 canonical な
timestamp フォーマット、 kernel が clock を読むタイミング、 operator の clock
操作の検知、 時刻と audit chain の相互作用を定義する。

## Clock sources

Takosumi は 3 種の clock source を区別する。 各 feature は 1 つの source に bind
される。 単一の決定で source を混ぜるのは kernel 実装 bug である。

- **Wall clock** — UTC, NTP-synchronized. Used for any value that an operator,
  integrator, or auditor must interpret as a calendar time: audit `ts`, TTL
  evaluation, approval `expiresAt`, idempotency window boundaries.
- **Monotonic clock** — process-local, never moves backward, advances during
  sleep. Used for any value that is meaningful only as a duration: operation
  duration, lock heartbeat, lock acquire timeout, rate limit window accounting,
  and worker poll backoff.
- **Logical / Lamport-like ordering** — derived from the audit hash chain
  (`prevHash`, `hash`). Used to order events deterministically even when
  wall-clock skew between pods would make `ts` ambiguous. The per-Space and
  global hash chains in [Audit Events](./audit-events.md#hash-chain) provide the
  order; `ts` is recorded for human reading, not for tie-breaking.

## Per-feature clock binding

下記 binding は normative である。

| Feature                                            | Clock source                                             |
| -------------------------------------------------- | -------------------------------------------------------- |
| Approval `expiresAt` evaluation                    | wall clock                                               |
| RevokeDebt aging window                            | wall clock; monotonic for the in-process grace timer     |
| Lock acquire timeout                               | monotonic                                                |
| Lock heartbeat / TTL                               | monotonic                                                |
| Audit event `ts`                                   | wall clock                                               |
| Audit event ordering                               | Lamport-like (chain hash); `ts` is informational         |
| Idempotency replay window                          | wall clock                                               |
| WAL stage retry backoff                            | monotonic                                                |
| Rate limit token bucket refill                     | monotonic                                                |
| Quota usage time bucket                            | wall clock (boundary) + monotonic (in-bucket arithmetic) |
| Telemetry metric histograms (`*_duration_seconds`) | monotonic                                                |
| Drift detection observation window                 | wall clock                                               |
| Compaction cadence                                 | wall clock (cron-style)                                  |

上 table に binding が無い feature は v1 で時刻を読んではいけない。 追加は
`CONVENTIONS.md` §6 RFC を通す。

## Clock skew tolerance

単一 installation 内の Takosumi pod は、 wall clock で互いに **5 秒** 以内に
留まらなければならない。 kernel は readiness probing でペアごとの skew を測る。

Rationale: 5 秒は practical NTP 同期で実用上達成できる範囲 (典型的には
sub-second) に十分な余裕を持たせつつ、 HMAC replay window や lock heartbeat TTL
と整合する閾値。 1 秒では NTP step / network jitter で false positive degrade
を頻発させ、 10 秒以上では timestamp ordering invariants と replay window
の前提が崩れる。

- The readiness probe rejects pods whose observed skew against the installation
  reference clock exceeds 5 seconds. The pod surfaces as `degraded` until skew
  returns to within tolerance.
- NTP synchronization is an operator responsibility. Operators configure the
  host's NTP daemon to track a stable upstream and do not let local drift exceed
  the tolerance.
- Cross-region installations are out of scope for v1. A v1 installation occupies
  a single time-coherence region.

Rationale: cross-region は wall clock skew + replication latency の合算が NTP
同期前提の 5 秒許容を超える可能性が高く、 multi-AZ within region とは異なる
failure model (network partition の頻度、 RTT の桁、 independent NTP fleet)
を持つ。 v1 は single region (multi-AZ within region は許容) のみを target に
invariants を validate し、 cross-region split-brain protocol は別 reference
として後追加する設計にしている。

skew event 自体は `severity: warning` と `errorCode: clock_skew_exceeded` を
持つ audit `operation-failed` event として記録される。

## Timestamp format

Takosumi のすべての timestamp は単一の canonical format を使う。

```text
RFC 3339 in UTC, millisecond precision, trailing Z

example: 2026-05-05T10:00:00.123Z
```

このフォーマットは audit log envelope、 kernel HTTP API、 runtime-agent API、
CLI 出力、 ログ行、 metric exemplar に一律に適用される。 他の zone offset、
ミリ秒未満の精度、 秒のみの形式は parse 時に reject される。

## TTL evaluation

TTL 評価は **その瞬間に** wall clock を読む。 cache から読まない。

- Approval `expiresAt`、 その他の TTL field は、 kernel が validity を判定する
  たびに毎回読み直す。 前回 request の cached decision は TTL チェックに
  再利用しない。
- 評価は strict。 `now > expiresAt` は expired。 `now == expiresAt` も expired。
  comparator に slop window は無い。 operator が tunable な grace が必要なら
  write 時に `expiresAt` 側で吸収する。
- 長い `observe` interval を跨いで TTL-bound binding を持ち続けた WAL stage は、
  次に binding に対して動くときに TTL を再評価する。 以前の評価は永続化しない。

## Operator clock operations

operator が host clock を調整する場面はある (NTP step、 manual set、 container
migration)。 kernel は最も破壊的なケースを検知する。

- kernel boot 時に毎回、 wall clock 値を記録し前回 shutdown 時の記録と比較
  する。 reverse jump (新しい値が記録より古い) は `severity: warning` で log
  する。
- wall clock の reverse jump が **1 時間** を超えた場合は safety abort 発動。
  operator が recovery CLI で jump を ack するまで kernel は `apply` に
  入らない。 この間の TTL 評価は block され、 すでに expired な approval や
  share の un-expiry を防ぐ。
- forward jump (clock が未来に動く) は許容するが、 5 分を超えた場合に
  `clock_forward_jump` audit event を出す。 forward jump は TTL field を 早期
  expire させる。 これは意図的な挙動である。

## Timezone handling

内部表現は end-to-end で UTC。 operator-facing surface は UTC 値の上に local
time を rendering してよい。

- kernel storage、 audit event、 telemetry exemplar、 HTTP API response はすべて
  UTC 値を運ぶ。
- operator UI と CLI 出力は、 operator が `TAKOSUMI_LOG_TIMEZONE` 等の
  client-side flag で opt-in したときに local zone で表示してよい。 内側の値 は
  UTC のまま。
- manifest / plan / snapshot は local-zone timestamp を運ばない。 non-UTC
  timestamp を含む manifest は `invalid_argument` で reject される。

## Clock and the audit chain

audit chain は整合性と clock 真値を切り離す。

- Each event records `ts` as the wall-clock value at write time. A later
  operator who finds `ts` implausible cannot rewrite the event without breaking
  `prevHash` continuity.
- Tamper detection runs on the chain hash, not on `ts`. A backdated `ts` (an
  event whose `ts` is older than its predecessor) is permitted by the chain
  rules but is surfaced by internal operator audit verification as a
  `non-monotonic-ts` warning. The current public `takosumi` CLI does not expose
  an `audit verify` command.
- Genesis events at chain rotation read the wall clock once; every later event
  in the rotation derives ordering from the chain.
- Cross-Space ordering is not implied by `ts`. Operators who need a cross-Space
  order use the global chain, not wall-clock comparison.

## Bootstrap

chain の最初の event (genesis または rotation 後の genesis) は wall clock を
読んで `ts` と chain identifier に使う。 同じ chain の以降の event はすべて、
前の event から `prevHash` を導出する。 後続の clock skew や operator clock
操作を跨いでも chain は有効なまま残る。

fresh kernel install で host clock が未設定の場合は hard boot failure として
扱う。 wall clock が kernel の release build date より前の Unix epoch を返す
ときは、 kernel は genesis event の書き込みを拒否する。 operator は最初の kernel
start 前に host clock と NTP source を設定する。

## Operator-facing summary

operator の最小義務は次の通り。

- Run NTP on every kernel and runtime-agent host with a stable upstream.
- Keep pairwise wall-clock skew within 5 seconds.
- Avoid manual reverse jumps greater than 1 hour. When unavoidable, acknowledge
  the jump via the recovery CLI before re-enabling `apply`.
- Surface clock skew alerts to the same on-call surface that handles audit-store
  and storage alerts.

これらの義務を満たせば、 per-feature binding table の全 clock-bound feature が
正しく動く。

## Related architecture notes

- `reference/architecture/operator-boundaries` — placement of NTP responsibility
  and the readiness contract.
- `reference/architecture/runtime-deployment-model#operation-plan--write-ahead-journal`
  — clock binding for WAL stage retry and idempotency window.
- `reference/architecture/policy-risk-approval-error-model` — approval
  `expiresAt` derivation and skew-related fail-closed rules.

## 関連ページ

- [Audit Events](./audit-events.md)
- [Approval Invalidation Triggers](./approval-invalidation.md)
- [RevokeDebt Model](./revoke-debt.md)
- [Cross-Process Locks](./cross-process-locks.md)
