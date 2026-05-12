# Trial Spaces

> Stability: stable Audience: operator, kernel-implementer See also:
> [Tenant Provisioning](/reference/tenant-provisioning),
> [Quota and Rate Limit](/reference/quota-rate-limit),
> [Audit Events](/reference/audit-events),
> [Compliance Retention](/reference/compliance-retention),
> [Tenant Export and Deletion](/reference/tenant-export-deletion),
> [Kernel HTTP API](/reference/kernel-http-api),
> [Closed Enums](/reference/closed-enums)

Takosumi v1 における **trial / ephemeral Space** の auto-expire 設計と quota
制限。trial Space は通常 Space と同等の isolation invariant を
保ったまま、寿命が有限で、低い quota tier が当たる Space。kernel は trial
attribute、auto-expire、frozen grace、auto-cleanup、operator-driven
extension、paid conversion を primitive として提供する。本 reference は
kernel-side の enforcement のみを定義する。

## Trial Space attribute

Space metadata に以下の field を追加する。

| Field              | Type      | Notes                                                           |
| ------------------ | --------- | --------------------------------------------------------------- |
| `trial`            | boolean   | `true` のとき trial Space。default `false`。                    |
| `trialExpiresAt`   | timestamp | RFC 3339 UTC。`trial: true` のとき必須。                        |
| `trialQuotaTierId` | string    | trial 専用 quota tier の ID。operator が事前に定義する。        |
| `trialOrigin`      | string    | trial 発生経路の operator-defined tag (provisioning 時に固定)。 |

`trialQuotaTierId` は operator 側で定義された tier を kernel が参照する
形で、kernel は具体的な caps を決め打ちしない。tier 自体は
[Quota and Rate Limit](/reference/quota-rate-limit) の closed dimension に caps
を attach する。

trial attribute は [Tenant Provisioning](/reference/tenant-provisioning) の
provisioning request の `metadata` 経由で立てる。trial flag が立った
provisioning は `quotaTierId` に `trialQuotaTierId` を強制し、これらの
組合せ違反は HTTP `409 Conflict` で reject される。

## Trial lifecycle

trial Space は通常 Space と同じ provisioning 段階を経て立ち上がる。 provisioning
後の lifecycle は以下の closed state を取る。

```text
active-trial | expiring-soon | frozen | cleaned-up | converted
```

| State           | 意味                                                                   |
| --------------- | ---------------------------------------------------------------------- |
| `active-trial`  | trial 期間内。通常 Space と同じ操作が可能、quota は trial tier。       |
| `expiring-soon` | `trialExpiresAt` 接近。書き込みは継続、warning audit を emit。         |
| `frozen`        | `trialExpiresAt` 経過。read-only 24h grace。復帰 / 延長 / 変換が可能。 |
| `cleaned-up`    | grace 経過後 auto-cleanup 完了。Space は削除済み。                     |
| `converted`     | paid Space に変換済み。trial state machine から外れる。                |

terminal は `cleaned-up` と `converted` の 2 値。

`expiring-soon` への遷移 threshold は operator-controlled。default は
`trialExpiresAt - TAKOSUMI_TRIAL_EXPIRY_WARN_SECONDS` (default 86400、24
時間前)。warning は audit event のみで、Space の操作性は変えない。

`frozen` 中は Space の write API がすべて HTTP `409 Conflict` で reject
され、read API のみ通る。grace duration は `TAKOSUMI_TRIAL_FROZEN_GRACE_SECONDS`
(default 86400、24 時間)。

grace 経過後、kernel は auto-cleanup を起動する。auto-cleanup は
[Tenant Export and Deletion](/reference/tenant-export-deletion) の Space
deletion API を internal caller として呼び出し、soft-delete → hard-delete
の通常経路を辿る。trial Space の auto-cleanup でも audit retention は
[Compliance Retention](/reference/compliance-retention) の regime に従う。

## Trial extension

`trialExpiresAt` の延長は operator 操作で行う。

- `POST /api/internal/v1/spaces/:id/trial/extend` で `trialExpiresAt` を 新
  timestamp に上書きする。
- 延長は `active-trial` / `expiring-soon` / `frozen` から実行できる。 `frozen`
  から延長すると `active-trial` (または warning window 内なら `expiring-soon`)
  に復帰する。
- `cleaned-up` / `converted` からの延長は HTTP `409 Conflict` で reject。
- actor self-service の延長は v1 範囲外。延長は operator policy で governance
  される (例えば payment 完了 / support 承認の確認は operator 側で実装する)。

延長操作は `trial-extended` audit event を emit し、`oldTrialExpiresAt` /
`newTrialExpiresAt` / 延長 actor を payload に保持する。

## Trial → paid conversion

paid Space への変換は metadata 編集と quota tier 切替の組合せ。

- `POST /api/internal/v1/spaces/:id/trial/convert` で `trial: false` に flip
  し、新 `quotaTierId` を attach する。
- conversion は `active-trial` / `expiring-soon` / `frozen` から実行可能。
  `cleaned-up` 後の Space は対象外。
- conversion は同じ Space ID と audit chain を継続するため、既存 deployment /
  artifact / Approval / RevokeDebt / observation はすべて そのまま引き継がれる。
- 変換後は `trialExpiresAt` / `trialQuotaTierId` / `trialOrigin` の field を
  kernel が clear し、metadata は paid Space と区別不能になる (audit log
  を除く)。

conversion は `trial-converted` audit event を emit し、`oldQuotaTierId` /
`newQuotaTierId` を payload に保持する。

## Trial quota tier の例

operator が定義する trial tier は以下のような caps を持つことを kernel が
想定している (具体値は operator policy)。

| Dimension                | 例     | Notes                                              |
| ------------------------ | ------ | -------------------------------------------------- |
| `deployment-count`       | 3      | 同時 active deployment の上限。                    |
| `artifact-storage-bytes` | 1 GB   | DataAsset 集計後の artifact 容量上限。             |
| journal retention        | 7 days | journal 自体の retention は trial 用に短縮できる。 |

journal retention の短縮は
[Compliance Retention](/reference/compliance-retention) の regime minimum
と整合する範囲でのみ許可される。`pci-dss` / `hipaa` / `sox` regime の Space
は短縮できず、operator は trial に該当 regime を割り当てない設計を 取る。

## Trial sandbox isolation

trial Space は通常 Space と同一の **kernel-enforced isolation invariant**
を持つ。具体的には、Space membership / namespace partition / secret partition /
quota 計上 / audit chain / observation set がすべて per-Space で fail-closed
に分離されており、trial / paid の区別なくこの invariant は kernel が直接強制する
(operator が無効化する余地は v1 で存在しない)。

この境界は意図的に二段構成になっている。

- 上記の per-Space partition / audit chain / secret partition は kernel
  invariant であり、quota tier policy をどう変えても trial Space が paid Space
  の partition を横断することはない。
- cross-Space share の将来解禁は operator-tunable quota tier policy ではなく、
  share を持たない。

具体的な fail-closed 経路:

- partition 分離 / quota 計上 / audit chain / secret partition / observation set
  はすべて per-Space で、trial か paid かで挙動を変えない (kernel invariant)。
- trial Space と production Space (paid Space) の間の cross-link は current v1
  で定義する。

## Audit events

trial lifecycle に関連する audit event
([Audit Events](/reference/audit-events)):

- `trial-space-created` — trial 属性付きで Space provisioning が完走。
- `trial-extended` — `trialExpiresAt` の延長。
- `trial-expired` — `trialExpiresAt` 経過、`frozen` 状態に遷移。
- `trial-converted` — paid Space への変換完了。
- `trial-cleaned-up` — grace 経過後の auto-cleanup 完了。

各 event payload は `spaceId` / `trialExpiresAt` / `trialQuotaTierId` / 新旧
lifecycle state を保持する。`trial-extended` は `oldTrialExpiresAt` /
`newTrialExpiresAt` を、`trial-converted` は `oldQuotaTierId` / `newQuotaTierId`
を追加で保持する。

## Configuration

trial の挙動は環境変数で operator が制御する。

| Variable                               | Type    | Default | Notes                                                  |
| -------------------------------------- | ------- | ------- | ------------------------------------------------------ |
| `TAKOSUMI_TRIAL_EXPIRY_WARN_SECONDS`   | integer | `86400` | `expiring-soon` への遷移 threshold。                   |
| `TAKOSUMI_TRIAL_FROZEN_GRACE_SECONDS`  | integer | `86400` | frozen grace の長さ。                                  |
| `TAKOSUMI_TRIAL_AUTO_CLEANUP_DISABLE`  | boolean | `false` | auto-cleanup を無効化 (operator 手動 cleanup を要求)。 |
| `TAKOSUMI_TRIAL_DEFAULT_QUOTA_TIER_ID` | string  | unset   | provisioning request 省略時の trial tier。             |

`TAKOSUMI_TRIAL_AUTO_CLEANUP_DISABLE=true` の operator は frozen 状態で hold
される Space を手動で deletion API に流す責務を負う。kernel は hold 中も
`trial-expired` event のみ emit し、`trial-cleaned-up` は operator
操作後に発火する。

## Invariants

- trial attribute は Space metadata の closed field 集合で表現する。
- trial lifecycle state は 5 値 closed。terminal は `cleaned-up` と
  `converted`。
- `frozen` は read-only で操作が落とされ、grace 経過後の auto-cleanup は Space
  deletion API を経由する。
- trial Space は current v1 で cross-Space link 不可。
- trial extension は operator-only で、actor self-service は v1 範囲外。

## kernel 範囲と外側の境界

本 reference は trial attribute と enforcement、auto-expire、conversion の
kernel-side primitive のみを定義する。trial signup の UI、credit-card- free
flow、free-tier テンプレートカタログ、conversion CTA、support escalation
等の顧客接点 flow は takosumi の範囲外で、operator が `takos-private/`
等の外側で実装する。kernel は trial flag、TTL、frozen
grace、auto-cleanup、conversion 経路を抽象として提供する。

## Related architecture notes

- `docs/reference/architecture/space-model.md` — Space lifecycle と trial
  attribute の isolation invariant 議論
- `docs/reference/architecture/operator-boundaries.md` — trial governance を
  operator policy に置く理由と kernel が emit する primitive の境界
- `docs/reference/architecture/exposure-activation-model.md` — `frozen` 状態で
  write を 落とし read を保つ fail-safe-not-fail-closed stance の整合
