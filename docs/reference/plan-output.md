# Plan Output

> Stability: stable
> Audience: integrator, kernel-implementer
> See also: [Kernel HTTP API](/reference/kernel-http-api), [CLI](/reference/cli), [Manifest Validation](/reference/manifest-validation), [Risk Taxonomy](/reference/risk-taxonomy), [Approval Invalidation Triggers](/reference/approval-invalidation), [WAL Stages](/reference/wal-stages), [Storage Schema](/reference/storage-schema), [Closed Enums](/reference/closed-enums)

本 reference は plan を消費する integrator (CLI / dashboard / external
controller) と plan を生成する kernel implementer の双方が参照する。
digest binding、approval propagation、WAL stage、operationKind 等の
構造的詳細は両 audience が共通 vocabulary として共有する。

`takosumi plan --json` および `POST /v1/deployments` の `mode: "plan"`
で返る plan output の正本仕様。Plan は **side-effect free**: WAL に書き
込みを行わず、resource の materialize / activate も行わない。同じ
manifest と同じ Space context に対して plan を繰り返し叩いても結果は
deterministic である。

Plan output は JSON。digest を含む field はすべて `sha256:<hex>` 形式で、
canonical encoding は [Storage Schema](/reference/storage-schema) で
定義する canonical bytes に対する sha256。

## Top-level shape

```yaml
PlanOutput:
  planId: string             # "plan:<ulid>"
  spaceId: string            # "space:<id>"
  desiredSnapshotDigest: string       # sha256:...
  operationPlanDigest: string         # sha256:...
  predictedActualEffectsDigest: string # sha256:...
  catalogReleaseId: string            # "catalog-release:<id>"
  generatedAt: string                 # RFC3339 UTC
  operations: OperationRecord[]
  risks: RiskRecord[]
  approvalBindings: ApprovalBinding[]
  errors: ErrorRecord[]
  warnings: WarningRecord[]
  summary: PlanSummary
```

`errors[]` が non-empty のとき `operations[]` は空とは限らないが、`apply`
モードでの consume はブロックされる。`warnings[]` は consume 可能だが
operator の確認が推奨される事象を載せる。

## OperationRecord

各 entry は plan された 1 operation。

```yaml
OperationRecord:
  operationId: string                 # "op:<ulid>"
  operationKind: enum                  # 下表
  target:
    kind: enum                         # object | link | exposure
    id: string                         # 対象の deterministic id
  generatedObjectIds: string[]         # plan 段階で確定する deterministic id
  approvedEffects:
    - effectFamily: string             # mutation 種別
      effectDetailDigest: string       # sha256:...
  lifecycleStage:
    phase: enum                        # apply | activate | destroy | rollback | recovery | observe
    walStages: enum[]                  # prepare | pre-commit | commit | post-commit | observe | finalize
  dependsOn: string[]                  # 先行 operationId
  notes: string                        # human-readable summary (1 行)
```

`operationKind` の closed enum:

```text
apply-object | delete-object | verify-object
materialize-link | rematerialize-link | revoke-link
prepare-exposure | activate-exposure
transform-data-asset | observe | compensate
```

`generatedObjectIds[]` は projection / link rendering で派生する
generated object の **deterministic id**。Plan 段階で確定するため、
operator は apply 前に id を inspect できる。

`approvedEffects[]` は **approval binding が cover する effect 単位**。
`effectDetailDigest` の集合が approval の `effectDetailsDigest` を構成する。

`walStages[]` は当該 operation が WAL に書く forward stage の集合。
`abort` / `skip` は terminal なので含めない。

## RiskRecord

Risk は plan の中で firing した closed taxonomy entry の dump。

```yaml
RiskRecord:
  stableId: string         # 安定識別子。kernel version 越しに不変
  kind: enum               # 19 値の closed Risk taxonomy
  subjectId: string        # object / link / exposure id
  severity: enum           # warning | error
  approvalRequired: boolean
  safeFix: string?         # apply 前に operator が適用できる固定文 (任意)
  requiresPolicyReview: boolean
  operatorFix: string?     # operator が手で直すべき指示 (任意)
  cause: object?           # 構造化された raw cause
```

`severity = error` の Risk が 1 つでも `approvalRequired = true` で
binding に紐付かない場合、plan は consume 不能。
[Risk Taxonomy](/reference/risk-taxonomy) が個々の rules を定義する。

## ApprovalBinding

Plan が要求する approval の wire shape。kernel は plan 1 件あたり最大
1 つの approval binding を発行する (該当 Risk が無ければ 0 件)。

```yaml
ApprovalBinding:
  bindingId: string                       # "approval:<ulid>"
  desiredSnapshotDigest: string           # plan input
  operationPlanDigest: string             # plan body
  effectDetailsDigest: string             # approvedEffects の canonical sha256
  predictedActualEffectsDigest: string    # observe 結果との照合用
  riskItemIds: string[]                   # 対応 RiskRecord.stableId
  status: enum                             # 下記
  expiresAt: string?                       # RFC3339 UTC
  invalidatedBy: enum?                     # 6 trigger
```

`status` の closed enum:

```text
pending | approved | denied | expired | invalidated | consumed
```

Plan output 内の approval binding は **plan 時点の status snapshot**。
実際の status 推移は `/api/internal/v1/approvals/:id` で観測する。

`invalidatedBy` は [Approval Invalidation Triggers](/reference/approval-invalidation)
の 6 値:

```text
digest-change | effect-detail-change | implementation-change
external-freshness-change | catalog-release-change | space-context-change
```

## ErrorRecord / WarningRecord

両者は同じ shape。`code` と `message` は
[Manifest Validation](/reference/manifest-validation) の error envelope と
整合する。

```yaml
ErrorRecord:
  code: enum             # DomainErrorCode 9 値
  message: string
  subjectPath: string    # JSONPath ($.resources[2].spec.port 等)
  safeFix: string?
  cause: object?
```

`code` の値域は [Closed Enums — DomainErrorCode](/reference/closed-enums#domainerrorcode)
の 9 値:

```text
invalid_argument | permission_denied | not_found
failed_precondition | resource_exhausted | not_implemented
unauthenticated | readiness_probe_failed | internal_error
```

`WarningRecord` は consume を block しない。Operator にレビューさせる
ために surface する。

## PlanSummary

Operator がダッシュボードで一覧する用の集計。

```yaml
PlanSummary:
  objects:
    byLifecycleClass:           # 5 値: managed | generated | external | operator | imported
      managed: integer
      generated: integer
      external: integer
      operator: integer
      imported: integer
  operations:
    byKind:                      # operationKind ごとの件数
      apply-object: integer
      materialize-link: integer
      prepare-exposure: integer
      activate-exposure: integer
      ...
  risks:
    bySeverity:
      warning: integer
      error: integer
    byKind:                      # Risk taxonomy 19 値
      collision-detected: integer
      grant-escalation: integer
      ...
  estimatedApplyDurationSeconds: integer  # 経験則ベース。SLA ではない
  approvalRequired: boolean
```

`estimatedApplyDurationSeconds` は kernel が直近の同種 operation 履歴から
出す目安で、SLA 値ではない。

## JSON encoding と digest

Plan output 自体は普通の JSON。`desiredSnapshotDigest` /
`operationPlanDigest` / `predictedActualEffectsDigest` /
`effectDetailsDigest` の各 digest は、canonical 化された **対象 entity の
bytes** に対する sha256 である。Canonical encoding rule は
[Storage Schema](/reference/storage-schema) で定義する。

Plan output JSON 自身を再 hash する操作は kernel が行わない。

## Side-effect free

Plan は次の保証を持つ。

- WAL への書き込みなし
- runtime-agent への lifecycle RPC なし
- 外部 connector への呼び出しなし (CatalogRelease の事前 fetch を除く)
- Space の quota counter に reserved entry を作らない (visibility のみ)

これにより plan は polling / CI / dashboard で安全に何度でも叩ける。

## Determinism

同一 (manifest digest, Space context, CatalogRelease id) tuple に対して
plan を 2 回叩くと、`generatedAt` を除く全 field が一致する。
`generatedAt` も含めた完全一致を要求する場合、`?fixedClock=...` で
override できる (CLI の `--fixed-clock` 経由)。

## Related design notes

- `docs/design/operation-plan-write-ahead-journal-model.md`
- `docs/design/policy-risk-approval-error-model.md`
- `docs/design/snapshot-model.md`
- `docs/design/execution-lifecycle.md`
- `docs/design/manifest-model.md`
