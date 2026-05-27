# 承認モデル {#policy-risk-approval-and-error-model}

::: info
内部設計メモ。public contract は [Installer API](../installer-api.md) を参照。
:::

policy は Space / snapshot / effect 情報を allow / deny / require-approval の判定に変換します。

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
  - authorization
  - network

effectDetails:
  secret:
    projectionFamily: secret-env
    rawValueStoredInCore: false
    updateBehavior: restart-required
  authorization:
    access: read-write
    target: database.primary.connection
    credentialTtlSeconds: 3600
  network:
    egress:
      - host: db.example.com
        protocol: tcp
        port: 5432
```

## Space ポリシーゲート {#space-policy-gate}

policy は operator-issued scoped installer context、account layer membership version、Space 内 platform service visibility を評価します。membership の実体は operator account layer が定義し、Takosumi は渡された context / policy snapshot で apply 可否を判定します。

```text
space-resolution:
  Is the actor allowed to deploy in this Space?

platform-service-resolution:
  Is the platform service path visible inside this Space?

space-secret-projection:
  May this Space receive the secret projection?

space-data-asset-use:
  May this Space read the asset?
```

current public v1 の platform service resolution は同一 Space 内で完結します。Space を跨ぐ sharing は future RFC で owner、access authorization、TTL、cleanup、risk enum をまとめて追加します。

## Risk 種別 {#risk-kind}

reference / operator の risk vocabulary です。operator の設定はこの vocabulary を approval や review workflow に採用できます。
`*-publication` を含む risk id は historical stable id です。current prose では
platform service entry / service snapshot として扱います。

| Risk                             | 説明                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `secret-projection`              | secret material が link / projection を通じて露出する。                                          |
| `platform-service`               | operator-owned platform service を consumer が利用する。                                         |
| `generated-credential`           | apply 時に credential（API key 等）が自動生成される。                                            |
| `generated-grant`                | apply 時に access authorization（IAM role 等）が自動生成される。wire 値は historical stable id。 |
| `network-egress`                 | component が外部ネットワークへの egress を要求する。                                             |
| `traffic-change`                 | activation が public traffic の routing を変更する。                                             |
| `stale-publication`              | 依存する platform service snapshot が stale 状態になっている。                                   |
| `revoked-publication`            | 依存する platform service entry が revoke されている。                                           |
| `cross-scope-link`               | current v1 で許可されない Space scope を跨ぐ link が作成される。                                 |
| `shadowed-publication`           | 同じ platform service path に複数の service entry が存在し、shadowing が発生する。               |
| `implementation-unverified`      | operator execution binding が未検証状態で使用される。                                            |
| `actual-effects-overflow`        | provider の実際の副作用が plan の予測を超えた。                                                  |
| `rollback-revalidation-required` | rollback 時に re-resolve / re-validate が必要。                                                  |
| `cleanup-backlog-created`        | destroy 失敗により CleanupBacklog record が作成された。                                          |
| `raw-secret-literal`             | secret が暗号化されずに literal として記録されている。                                           |
| `collision-detected`             | link / projection の名前衝突が検出された。                                                       |

詳細: `collision-detected` は [Link and Projection Model — Collision rules](./binding-model.md)、 source transform approval は build service / operator pre-submission policy の外部 error として扱います。

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
  expectedEffectsDigest: sha256:...
  effectDetailsDigest: sha256:...
  actor: ...
  policyVersion: ...
  expiresAt: ...
```

## Approval 無効化トリガー {#approval-invalidation-triggers}

reference / operator の trigger vocabulary です。各 trigger は独立しており、 operator の approval 設定はこれらの変更が観測されたときに approval を無効化できます。

```text
1. digest change
   TargetState digest or OperationPlan digest no longer matches
   expectedEffectsDigest no longer matches
   the value the approval bound to.

2. effect-detail change
   approvedEffects, effectDetailsDigest, authorization access, or network egress
   has changed since approval.

3. implementation change
   The selected Implementation for any operation has changed.

4. external freshness change
   snapshot が参照する operator 所有の PlatformServiceDeclaration が最新でなくなった

5. operator implementation config change
   The operator-provided kind alias / binding visibility used by the Space has changed.

6. Space-context change
   Space id, Space membership, or Space policy pack governing this resolution
```

## Error モデル {#error-model}

Reference resolution / operation planning の失敗は次のような structured detail を返せます。Core Installer API の互換エラーレスポンスは [Installer API](../installer-api.md#errors) が定義します。

```yaml
Error:
  subject: link_api_DATABASE_URL
  reason: access-required
  candidates: []
  safeFix: []
  requiresPolicyReview: []
  operatorFix: []
```

fix hint は分類されます。 access escalation / external link / network 拡大は safe fix として提示しません。

## Policy pack {#policy-pack}

operator は policy pack から選び、差分のみを override します。

```text
dev/open
external/simple
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

`reviewing` は client view にのみ存在する soft 状態で、Takosumi の record は `pending` のままです。claim 解除は idle timeout で自動失効します。

### バッチ処理 {#batching}

1 つの OperationPlan が複数 Risk を発火させた場合、Takosumi は **plan 単位で 1 approval を発行** し、`riskItemIds[]` に該当 Risk を列挙します。Risk ごとに individual approval を切らない理由は、approver が Risk 同士の relation (secret-projection と generated authorization が同 component に属する等) を横断的に判断する必要があるためです。closed enum 18 entries の Risk はすべてこの batching で処理されます。

### 無効化の伝播 {#invalidation-propagation}

Approval invalidation triggers は 6 個の独立 trigger で、いずれか 1 つが発火すれば approval 全体が `invalidated` 状態に遷移します。digest 系 (trigger 1, 2) は同一 plan 内の他 binding を再評価せずに **短絡 invalidate** します。digest が変わったということは plan を全面 re-resolve する必要があり、partial valid を残すと approver が古い前提で承認した状態が混在するためです。trigger 3-6 は plan を保ったまま発火するため、Takosumi は影響範囲を minimum approval set に絞って propagate します。

## エラーレスポンスの philosophy (cross-link) {#error-envelope-philosophy-cross-link}

API surface 側のエラーレスポンス `{ code, message, requestId, details? }` と本 model の Error fix-hint 分類 (safeFix / requiresPolicyReview / operatorFix) は別レイヤで動作します。

- **error vs Risk**: Risk は plan 出力の判定点 (allow / deny / require-approval に分岐させる data)。Error は operation result の失敗理由 (resolution / apply / destroy が走り終わった後の outcome)。Risk は approve で吸収可能、 Error は再 plan / 再 apply で解消する性質を持ちます。
- **fix-hint 生成 stage**: WAL の `prepare` stage で `safeFix[]` (manifest 上自動補正可能な提案) が、`pre-commit` stage で `requiresPolicyReview[]` (approval が要る昇格) が、`commit` / `post-commit` / `observe` / `finalize` stage で `operatorFix[]` (operator 介入が要る) が生成されます。詳細 stage 定義は [Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal) 。
- access escalation / external link 拡張 / network egress 拡張は **safeFix に載せない** という invariant はエラーレスポンスの自動分類でも維持されます。

## クロスリファレンス {#cross-references}

- Architecture: [API Surface Architecture](./api-surface-architecture.md)
- Architecture: [Operation Plan & Write-Ahead Journal](./runtime-deployment-model.md#operation-plan--write-ahead-journal)
- Architecture: [Space Model](./space-model.md)
- Architecture: [Drift Detection](../drift-detection.md)
- Reference: [Reference Kernel Route Inventory](../kernel-http-api.md)
- Reference: [Reference Runtime-Agent Execution Surface](../runtime-agent-api.md)
