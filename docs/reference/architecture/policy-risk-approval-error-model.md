# Reference Policy / Risk / Approval Profile {#policy-risk-approval-and-error-model}

This page describes a reference/operator approval profile. It is not the
Takosumi core Installer API contract. Core dry-run/apply compatibility is the
`changes[]` response, `expected` guards, Deployment records, and the closed wire
error envelope documented in [Installer API](../installer-api.md).

policy は Space / snapshot / effect 情報を allow / deny / require-approval
の判定に変換します。

## Policy の結果 {#policy-outcome}

```text
allow
deny
require-approval
```

## Effect モデル {#effect-model}

policy は family と detail の両方を評価する必要があります。

```yaml
effectFamilies:
  - secret
  - grant
  - network

effectDetails:
  secret:
    projectionFamily: secret-env
    rawValueStoredInCore: false
    updateBehavior: restart-required
  grant:
    access: read-write
    target: publisher.database.primary
    credentialTtlSeconds: 3600
  network:
    egress:
      - host: db.example.com
        protocol: tcp
        port: 5432
```

## Space ポリシーゲート {#space-policy-gate}

policy は operator-issued scoped installer context、account-plane membership
version、Space 内 external publication visibility を評価します。membership の
実体は operator account plane が所有し、kernel は渡された context / policy
snapshot で apply 可否を判定します。

```text
space-resolution:
  Is the actor allowed to deploy in this Space?

publication-scope-resolution:
  Is the publication visible inside this Space?

space-secret-projection:
  May this Space receive the secret projection?

space-data-asset-use:
  May this Space read the DataAsset?
```

current public v1 の external publication resolution は同一 Space
内で完結します。Space を跨ぐ sharing は future RFC で
owner、grant、TTL、cleanup、risk enum をまとめて 追加します。

## Risk 種別 {#risk-kind}

Reference/operator risk vocabulary. Operator distributions can adopt this
vocabulary for approval and review workflows.

| Risk                             | 説明                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `secret-projection`              | secret material が link / projection を通じて露出する。                              |
| `external-publication`           | operator-owned external publication を consumer が利用する。                         |
| `generated-credential`           | apply 時に credential（API key 等）が自動生成される。                                |
| `generated-grant`                | apply 時に access grant（IAM role 等）が自動生成される。                             |
| `network-egress`                 | component が外部ネットワークへの egress を要求する。                                 |
| `traffic-change`                 | activation が public traffic の routing を変更する。                                 |
| `stale-publication`              | 依存する operator publication が stale 状態になっている。                            |
| `revoked-publication`            | 依存する operator publication が revoke されている。                                 |
| `cross-scope-link`               | 異なる Space-visible publication scope を跨ぐ link が作成される。                    |
| `shadowed-publication`           | 同じ external publication path に複数の publication が存在し、shadowing が発生する。 |
| `implementation-unverified`      | operator execution binding が未検証状態で使用される。                                |
| `actual-effects-overflow`        | provider の実際の副作用が plan の予測を超えた。                                      |
| `rollback-revalidation-required` | rollback 時に re-resolve / re-validate が必要。                                      |
| `revoke-debt-created`            | destroy 失敗により RevokeDebt record が作成された。                                  |
| `raw-secret-literal`             | secret が暗号化されずに literal として記録されている。                               |
| `collision-detected`             | link / projection の名前衝突が検出された。                                           |

詳細: `collision-detected` は
[Link and Projection Model — Collision rules](./link-projection-model.md)、
source transform approval は build service / operator pre-submission policy の
外部 error として扱います。

## Approval ライフサイクル {#approval-lifecycle}

```text
pending
approved
denied
expired
invalidated
consumed
```

approval は以下に bind します。

```yaml
Approval:
  spaceId: space_acme_prod
  desiredSnapshotDigest: sha256:...
  operationPlanDigest: sha256:...
  riskItemIds: []
  approvedEffects: {}
  predictedActualEffectsDigest: sha256:...
  effectDetailsDigest: sha256:...
  actor: ...
  policyVersion: ...
  expiresAt: ...
```

## Approval 無効化トリガー {#approval-invalidation-triggers}

Reference/operator trigger vocabulary. Each trigger is independent; an operator
approval profile can invalidate approval when one of these changes is observed.

```text
1. digest change
   DesiredSnapshot digest or OperationPlan digest no longer matches
   predictedActualEffectsDigest no longer matches
   the value the approval bound to.

2. effect-detail change
   approvedEffects, effectDetailsDigest, grant access, or network egress
   has changed since approval.

3. implementation change
   The selected Implementation for any operation has changed.

4. external freshness change
   snapshot が参照する operator 所有の ExternalPublicationDeclaration が最新でなくなった

5. operator implementation config change
   The operator-provided kind alias / implementation binding visibility used by the Space has changed.

6. Space-context change
   Space id, Space membership, or Space policy pack governing this resolution
```

## Error モデル {#error-model}

Reference resolution / operation planning の失敗は次のような structured detail を
返せます。Core Installer API の互換 error envelope は
[Installer API](../installer-api.md#errors) が定義します。

```yaml
Error:
  subject: link_api_DATABASE_URL
  reason: access-required
  candidates: []
  safeFix: []
  requiresPolicyReview: []
  operatorFix: []
```

fix hint は分類されます。 access escalation / external link / network 拡大は
safe fix として提示しません。

## Policy pack {#policy-pack}

operator は policy pack から選び、差分のみを override します。

```text
dev/open
selfhost/simple
prod/default
prod/strict
enterprise/descriptor-approved-only
```

## Approval フローアーキテクチャ {#approval-flow-architecture}

### Approver UX 状態 {#approver-ux-states}

approver が見る client 可視状態は approval lifecycle に対応します。

```text
pending     decision 待ち。approver inbox に表示
reviewing   approver が claim 済み。他の approver の重複作業を抑制
approved    approve 済みかつ未消化。binding する OperationPlan が apply 可能
denied      reject 済み。同 plan は再 propose しない限り再開不能
expired     expiresAt 経過。再 propose で新規 approval が必要
```

`reviewing` は client view にのみ存在する soft 状態で、kernel record は
`pending` のままです。claim 解除は idle timeout で自動失効します。

### バッチ処理 {#batching}

1 つの OperationPlan が複数 Risk を発火させた場合、kernel は **plan 単位で 1
approval を発行** し、`riskItemIds[]` に該当 Risk を列挙します。Risk ごとに
individual approval を切らない理由は、approver が Risk 同士の relation
(secret-projection と grant が同 component に属する等) を横断的に判断
する必要があるためです。closed enum 18 entries の Risk はすべてこの batching
で処理されます。

### 無効化の伝播 {#invalidation-propagation}

Approval invalidation triggers は 6 個の独立 trigger で、いずれか 1 つが
発火すれば approval 全体が `invalidated` 状態に遷移します。digest 系 (trigger
1, 2) は同一 plan 内の他 binding を再評価せずに **短絡 invalidate**
します。digest が変わったということは plan を全面 re-resolve する必要が
あり、partial valid を残すと approver が古い前提で承認した状態が混在する
ためです。trigger 3-6 は plan を保ったまま発火するため、kernel は影響範囲を
minimum approval set に絞って propagate します。

## エラー envelope の philosophy (cross-link) {#error-envelope-philosophy-cross-link}

API surface 側の error envelope `{ code, message, requestId, details? }` と本
model の Error fix-hint 分類 (safeFix / requiresPolicyReview / operatorFix)
は別レイヤで動作します。

- **error vs Risk**: Risk は plan 出力の判定点 (allow / deny / require-approval
  に分岐させる data)。Error は operation result の失敗理由 (resolution / apply /
  destroy が走り終わった後の outcome)。Risk は approve で吸収可能、 Error は再
  plan / 再 apply で解消する性質を持ちます。
- **fix-hint 生成 stage**: WAL の `prepare` stage で `safeFix[]` (AppSpec 上
  自動補正可能な提案) が、`pre-commit` stage で `requiresPolicyReview[]`
  (approval が要る昇格) が、`commit` / `post-commit` / `observe` / `finalize`
  stage で `operatorFix[]` (operator 介入が要る) が生成されます。詳細 stage
  定義は
  [Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal)
  。
- access escalation / external link 拡張 / network egress 拡張は **safeFix
  に載せない** という invariant は API envelope の自動分類でも維持されます。

## クロスリファレンス {#cross-references}

- Architecture: [API Surface Architecture](./api-surface-architecture.md)
- Architecture:
  [Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal)
- Architecture: [Space Model](./space-model.md)
- Architecture: [Drift Detection](../drift-detection.md)
- Reference: [Reference Kernel Route Inventory](../kernel-http-api.md)
- Reference:
  [Reference Runtime-Agent Execution Surface](../runtime-agent-api.md)
