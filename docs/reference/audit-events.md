# Audit Events

> このページでわかること: kernel が emit する audit event の型と保存ルール。

audit log は Takosumi installation 内の決定 / 状態遷移 / operator から見え
る副作用を tamper-evident に記録するものです。 本ページは v1 の event taxonomy
を定義します。 共通 envelope、 閉じた event type enum、 query 用 indexed
column、 secret を audit store に残さない redaction rule、 tamper-evidence
を担保する hash chain、 Space 毎に operator が選ぶ retention regime を扱います。

## 共通 event envelope

すべての audit event は同じ envelope を持ちます。 hash 計算で用いる field
集合と順序が安定していれば、 serialize は JSON / CBOR / その他 canonical
encoding でも構いません。

| Field       | 型        | 必須 | 内容                                                                                      |
| ----------- | --------- | ---- | ----------------------------------------------------------------------------------------- |
| `eventId`   | string    | yes  | event ごとに一意                                                                          |
| `ts`        | timestamp | yes  | RFC 3339 UTC、 ミリ秒精度                                                                 |
| `actor`     | string    | yes  | event を起こした principal (operator id、 deploy bearer subject、 kernel 起源は `system`) |
| `eventType` | enum      | yes  | 下記閉じた v1 enum                                                                        |
| `severity`  | enum      | yes  | `info` / `notice` / `warning` / `error` / `critical`                                      |
| `prevHash`  | sha256    | yes  | chain 内の直前 event の hash                                                              |
| `hash`      | sha256    | yes  | `prevHash` を含む当 event の canonical bytes の hash                                      |

envelope は event type 固有の `payload` object も持ちます。 schema は event type
ごとに固定で、 未知 payload field は書込時に reject されます (RFC なし の
envelope 拡張は不可)。

## 閉じた event type enum (v1)

v1 の audit event taxonomy は閉じています。 kernel / identity / tenant / PaaS
operations / workflow ドメインで 88 以上の event type を含みます。 追加には
`CONVENTIONS.md` §6 RFC が必要で、 既存値を置換せず追加のみ可能で す。

Deployment lifecycle:

- `deployment-created`
- `deployment-applied`
- `deployment-destroyed`

Resolve / desired:

- `resolution-recorded`
- `desired-recorded`

Operation / WAL:

- `operation-intent-recorded`
- `operation-completed`
- `operation-failed`
- `compensation-completed`

Approval:

- `approval-issued`
- `approval-consumed`
- `approval-denied`
- `approval-invalidated`

RevokeDebt:

- `revoke-debt-created`
- `revoke-debt-aged`
- `revoke-debt-cleared`

Activation:

- `activation-snapshot-created`
- `group-head-moved`

Drift:

- `drift-detected`

- `share-created`
- `share-activated`
- `share-refreshed`
- `share-stale`
- `share-revoked`

Catalog and connector:

- `catalog-release-adopted`
- `catalog-release-rotated`
- `publisher-key-enrolled`
- `publisher-key-revoked`

- `external-participant-registered`
- `external-participant-revoked`

Secret partition:

- `secret-partition-rotated`

Locks:

- `lock-acquired`
- `lock-released`
- `lock-recovered`

Identity:

- `api-key-issued`
- `api-key-rotated`
- `api-key-revoked`
- `api-key-used`
- `api-key-expired`
- `auth-provider-registered`
- `auth-provider-revoked`
- `auth-success`
- `auth-failure`
- `membership-invited`
- `membership-accepted`
- `membership-left`
- `membership-removed`
- `role-assignment-created`
- `role-assignment-revoked`
- `role-assignment-expired`

Tenant:

- `space-provisioned`
- `space-provisioning-failed`
- `space-export-started`
- `space-export-completed`
- `space-export-failed`
- `space-soft-deleted`
- `space-restored`
- `space-hard-deleted`
- `space-redaction-applied`

Trial:

- `trial-space-created`
- `trial-extended`
- `trial-expired`
- `trial-converted`
- `trial-cleaned-up`

Incident:

- `incident-detected`
- `incident-acknowledged`
- `incident-state-changed`
- `incident-severity-changed`
- `incident-resolved`
- `incident-postmortem-published`

Support impersonation:

- `support-impersonation-requested`
- `support-impersonation-approved`
- `support-impersonation-rejected`
- `support-impersonation-revoked`
- `support-impersonation-expired`
- `support-impersonation-session-started`
- `support-impersonation-session-ended`
- `support-impersonation-write-action-recorded`

Notification:

- `notification-emitted`
- `notification-acknowledged`

SLA:

- `sla-warning-raised`
- `sla-breach-detected`
- `sla-recovering`
- `sla-recovered`
- `sla-threshold-changed`

Cost / quota:

- `space-attribution-changed`
- `quota-tier-registered`
- `quota-tier-updated`
- `quota-tier-removed`
- `space-tier-changed`

上記がすべての v1 enum 値です。 これ以外の値は書込時に reject され、 audit store
integrity failure として表面化します。

## Indexed column

audit store は以下を index します。

- `spaceId`: Space 毎 query の主スコープ
- `ts`: time-range query / retention sweep に必須
- `actor`: actor 軸の調査 query に必須
- `eventType`: taxonomy 絞り込みに必須

実装は他列 (`severity` 等) の index 追加可ですが、 caller に追加 index を
要求してはいけません。

## Redaction rule

secret 値は audit log に出ません。 secret partition rotation、 secret access
decision、 secret-bound approval はすべて value ではなく reference
で記録します。

- `secret-partition-rotated` は partition 識別子、 旧 / 新 partition digest、
  actor を記録。 plaintext secret は持たない
- payload に secret 値が入りそうな event は、 secret reference
  (`secret://<partition>/<key>`) と access decision の digest を記録する
- 書込時、 canonical payload に active secret-partition redaction set の
  部分文字列が含まれていたら kernel は audit write を reject。 拒否自体は
  `severity: critical` の `operation-failed` event
  (`errorCode: secret_redaction_failed`) として記録される

redaction rule は caller ではなく audit writer 側で enforce され、 不備の ある
caller は検出され reject されます。

## Hash chain

audit log は per-Space chain と global chain で tamper-evidence を保ちます。

Rationale: per-Space chain は tenant 内 audit integrity を Space operator 単独で
verify 可能にし、Space 間で互いに信頼を要求しない。global chain は cross-Space
event の total order を保証し、checkpoint で全 Space の chain head を bundle
する。1 chain だけでは Space tenant の独立 audit と global ordering
を両立できず、per-Space のみでは cross-Space 攻撃 (片側を 削除して別 Space
で再生する等) を検出できない。

- 各 event の `hash` は `prevHash` を含む canonical envelope bytes の digest。
  単一 event の改竄は、 genesis から chain を再導出すれば最初の差異 event
  として検出できる
- Space ごとに独自 per-Space chain を持ち、 `prevHash` は当該 Space 内の 直前
  event を参照する
- per-Space chain の上に global chain を重ねる。 per-Space chain の rotation
  point で global checkpoint を生成し、 global `prevHash` は前 global checkpoint
  を、 payload は rotation 時の per-Space chain head 群を含む
- chain rotation は `TAKOSUMI_AUDIT_CHAIN_ROTATION_INTERVAL_HOURS` (既定 `24`)
  の周期と on-demand で実施。 rotation 期間中に `lock-acquired` /
  `lock-released` の 1 対を emit

改竄検出は offline で行います。 operator は internal operator tooling で chain
integrity を検証します (公開 `takosumi` CLI に `audit verify` はあり ません)。

検証は genesis から chain を辿り、 各 hash を再計算して最初の差異 event を
報告します。 検証は audit store を変更せず、 kernel の停止も要求しません。

## Retention regime

audit retention は Space 単位の regime で制御します。 各 regime は既定 retention
window と、 期間中 query 可能であるべき field 集合を固定します。

- `default`: operator が調整する retention window。 compliance 保証なし
- `pci-dss`: PCI DSS 準拠
- `hipaa`: HIPAA 準拠
- `sox`: SOX 準拠
- `regulated`: 上記 regime を超える法域要件向け operator 拡張

regime そのもの、 含意する retention window、 保護対象 field 集合、 regime
選定規則は operator 向け compliance reference に定義。 本ページは event shape
contract のみを定義し、 retention window はここに記録された event に
紐付きます。

実装状況:

- `SqlObservabilitySink.applyRetentionPolicy()` は configured audit replication
  sink へ delivery された後でのみ candidate を archive
- `ObjectStorageAuditReplicationSink` は chained audit record を generic
  `ObjectStoragePort` 経由で `<prefix>/events/<sequence>-<hash>.json` に JSON
  書出。 long-term retention を S3 Object Lock / GCS Bucket Lock / R2 / MinIO
  等の immutable object-store で受けられる
- `TAKOSUMI_AUDIT_DELETE_AFTER_ARCHIVE=true` は replication sink が attach
  されているときのみ受理。 delivery 確認が無ければ primary row は SQL audit
  store に残る

## Event payload の注意

各 payload は `eventType` 固有の closed schema に従い、
[Storage Schema](/reference/storage-schema) で定義する record を参照します。

- resolve / desired / operation / activation event は ResolutionSnapshot /
  DesiredSnapshot / OperationPlan / JournalEntry / ActivationSnapshot の id /
  digest を参照
- approval event は Approval id と closed risk enum を参照
- drift / RevokeDebt event は DriftIndex / RevokeDebt の id と lifecycle 遷
  移を参照
- catalog / connector event は `connector:<id>` 形式の Connector identity を参照
  ([Connector Contract](/reference/connector-contract))

書込時、 audit store の referential view 上で resolve できない id を含む payload
は reject されます。

## Identity events

| Event                      | Severity | Description                                                | Payload fields                                                       |
| -------------------------- | -------- | ---------------------------------------------------------- | -------------------------------------------------------------------- |
| `api-key-issued`           | info     | actor に対して APIKey が発行された。                       | `apiKeyId`, `actorId`, `kind`, `scope`, `expiresAt`, `issuedBy`      |
| `api-key-rotated`          | info     | APIKey rotation により既存 key から新 key が生成された。   | `apiKeyId`, `rotatedFromId`, `actorId`, `expiresAt`, `rotatedBy`     |
| `api-key-revoked`          | warning  | APIKey が自然失効前に revoke された。                      | `apiKeyId`, `actorId`, `reason`, `revokedBy`                         |
| `api-key-used`             | info     | 認証境界で APIKey が提示された。                           | `apiKeyId`, `actorId`, `kind`, `requestPath`, `result`               |
| `api-key-expired`          | info     | APIKey が `expiresAt` に到達し自動 revoke された。         | `apiKeyId`, `actorId`, `expiresAt`                                   |
| `auth-provider-registered` | notice   | AuthProvider レコードが operator によって install された。 | `providerId`, `type`, `registeredBy`                                 |
| `auth-provider-revoked`    | warning  | AuthProvider が revoke された。                            | `providerId`, `type`, `revokedBy`, `reason`                          |
| `auth-success`             | info     | 認証試行が actor identity を解決した。                     | `actorId`, `providerId`, `mechanism`, `requestPath`                  |
| `auth-failure`             | warning  | kernel 管理の境界で認証試行が失敗した。                    | `providerId`, `mechanism`, `requestPath`, `errorCode`                |
| `membership-invited`       | info     | actor が Organization に招待された。                       | `organizationId`, `actorId`, `role`, `invitedBy`                     |
| `membership-accepted`      | info     | actor が Organization membership 招待を受諾した。          | `organizationId`, `actorId`, `role`, `acceptedAt`                    |
| `membership-left`          | notice   | actor が自発的に Organization を離脱した。                 | `organizationId`, `actorId`, `leftAt`                                |
| `membership-removed`       | warning  | 別 actor によって Organization から actor が削除された。   | `organizationId`, `actorId`, `removedBy`, `reason`                   |
| `role-assignment-created`  | notice   | role と actor を結びつける RoleAssignment が作成された。   | `assignmentId`, `actorId`, `scope`, `scopeId`, `role`, `assignedBy`  |
| `role-assignment-revoked`  | warning  | RoleAssignment が revoke された。                          | `assignmentId`, `actorId`, `scope`, `scopeId`, `revokedBy`, `reason` |
| `role-assignment-expired`  | info     | RoleAssignment が `expiresAt` に到達し自動 revoke された。 | `assignmentId`, `actorId`, `scope`, `scopeId`, `expiresAt`           |

See also: [Actor / Organization Model](/reference/actor-organization-model),
[API Key Management](/reference/api-key-management),
[Auth Providers](/reference/auth-providers),
[RBAC Policy](/reference/rbac-policy).

## Tenant events

| Event                       | Severity | Description                                                     | Payload fields                                                             |
| --------------------------- | -------- | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `space-provisioned`         | info     | Space の provisioning が正常完了した。                          | `spaceId`, `organizationId`, `quotaTierId`, `provisioningSessionId`        |
| `space-provisioning-failed` | error    | Space provisioning セッションが失敗し rollback された。         | `provisioningSessionId`, `spaceId`, `stage`, `errorCode`                   |
| `space-export-started`      | info     | Space export job が開始された。                                 | `exportJobId`, `spaceId`, `mode`, `requestedBy`                            |
| `space-export-completed`    | info     | Space export job が完了し artifact を生成した。                 | `exportJobId`, `spaceId`, `mode`, `artifactSha256`, `downloadUrlExpiresAt` |
| `space-export-failed`       | error    | Space export job が失敗した。                                   | `exportJobId`, `spaceId`, `mode`, `errorCode`                              |
| `space-soft-deleted`        | warning  | Space が soft-deleted state に置かれた。                        | `spaceId`, `requestedBy`, `softDeletedAt`, `retentionExpiresAt`            |
| `space-restored`            | notice   | soft-deleted の Space が復元された。                            | `spaceId`, `restoredBy`, `restoredAt`                                      |
| `space-hard-deleted`        | critical | Space が hard-delete された。 tenant データは復元不能。         | `spaceId`, `requestedBy`, `hardDeletedAt`, `redactionDigest`               |
| `space-redaction-applied`   | warning  | Space に対して right-to-erasure による redaction が適用された。 | `spaceId`, `requestedBy`, `redactionScope`, `redactionDigest`              |

See also: [Tenant Provisioning](/reference/tenant-provisioning),
[Tenant Export / Deletion](/reference/tenant-export-deletion).

## Trial events

| Event                 | Severity | Description                                                        | Payload fields                                                                   |
| --------------------- | -------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `trial-space-created` | info     | trial 属性を持つ Space が作成された。                              | `spaceId`, `organizationId`, `trialExpiresAt`, `trialQuotaTierId`, `trialOrigin` |
| `trial-extended`      | notice   | trial Space の `trialExpiresAt` が延長された。                     | `spaceId`, `previousExpiresAt`, `newExpiresAt`, `extendedBy`                     |
| `trial-expired`       | warning  | trial Space が conversion されないまま `trialExpiresAt` を過ぎた。 | `spaceId`, `trialExpiresAt`                                                      |
| `trial-converted`     | info     | trial Space が paid quota tier に conversion された。              | `spaceId`, `previousQuotaTierId`, `newQuotaTierId`, `convertedBy`                |
| `trial-cleaned-up`    | warning  | 失効した trial Space が clean up された。                          | `spaceId`, `cleanedUpAt`, `redactionDigest`                                      |

See also: [Trial Spaces](/reference/trial-spaces).

## Incident events

| Event                           | Severity | Description                                              | Payload fields                                                           |
| ------------------------------- | -------- | -------------------------------------------------------- | ------------------------------------------------------------------------ |
| `incident-detected`             | error    | 自動検出または operator により incident が open された。 | `incidentId`, `severity`, `origin`, `affectedSpaceIds`, `affectedOrgIds` |
| `incident-acknowledged`         | notice   | operator により incident が ack された。                 | `incidentId`, `acknowledgedBy`, `acknowledgedAt`                         |
| `incident-state-changed`        | notice   | incident が lifecycle state 間で遷移した。               | `incidentId`, `previousState`, `newState`, `changedBy`                   |
| `incident-severity-changed`     | warning  | incident の severity level が変更された。                | `incidentId`, `previousSeverity`, `newSeverity`, `changedBy`             |
| `incident-resolved`             | notice   | incident が resolve された。                             | `incidentId`, `resolvedBy`, `resolvedAt`, `rootCause`                    |
| `incident-postmortem-published` | info     | incident に postmortem が紐付けられた。                  | `incidentId`, `postmortemDigest`, `publishedBy`                          |

See also: [Incident Model](/reference/incident-model),
[SLA Breach Detection](/reference/sla-breach-detection).

## Support impersonation events

| Event                                         | Severity | Description                                                            | Payload fields                                                 |
| --------------------------------------------- | -------- | ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| `support-impersonation-requested`             | warning  | support actor が Space に対する impersonation grant を要求した。       | `grantId`, `supportActorId`, `spaceId`, `scope`, `requestedAt` |
| `support-impersonation-approved`              | warning  | impersonation grant が承認された。                                     | `grantId`, `approvedBy`, `approvedAt`, `expiresAt`             |
| `support-impersonation-rejected`              | notice   | impersonation grant 要求が却下された。                                 | `grantId`, `rejectedBy`, `reason`                              |
| `support-impersonation-revoked`               | warning  | 承認済の impersonation grant が早期 revoke された。                    | `grantId`, `revokedBy`, `reason`                               |
| `support-impersonation-expired`               | info     | impersonation grant が `expiresAt` に到達した。                        | `grantId`, `expiresAt`                                         |
| `support-impersonation-session-started`       | warning  | support actor が承認済 grant の下で impersonation session を開始した。 | `sessionId`, `grantId`, `acceptScope`, `openedAt`              |
| `support-impersonation-session-ended`         | notice   | support impersonation session が終了した。                             | `sessionId`, `grantId`, `endedAt`, `endReason`                 |
| `support-impersonation-write-action-recorded` | warning  | read-write impersonation session 内で write action が実行された。      | `sessionId`, `grantId`, `actionDigest`, `targetResource`       |

See also: [Support Impersonation](/reference/support-impersonation).

## Notification events

| Event                       | Severity | Description                                                       | Payload fields                                                  |
| --------------------------- | -------- | ----------------------------------------------------------------- | --------------------------------------------------------------- |
| `notification-emitted`      | info     | NotificationSignal が pull-only delivery surface に emit された。 | `signalId`, `category`, `scope`, `scopeId`, `recipientActorIds` |
| `notification-acknowledged` | info     | NotificationSignal が受信側 actor によって ack された。           | `signalId`, `actorId`, `acknowledgedAt`                         |

See also: [Notification Emission](/reference/notification-emission).

## SLA events

| Event                   | Severity | Description                                                           | Payload fields                                                                           |
| ----------------------- | -------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `sla-warning-raised`    | warning  | SLA dimension が breach 前の warning band に入った。                  | `dimension`, `scope`, `scopeId`, `value`, `thresholdId`                                  |
| `sla-breach-detected`   | warning  | SLA threshold を breach した。                                        | `dimension`, `scope`, `scopeId`, `value`, `thresholdId`, `incidentId`                    |
| `sla-recovering`        | warning  | SLA dimension が hysteresis 期間中に nominal に向けて回復しつつある。 | `dimension`, `scope`, `scopeId`, `value`, `thresholdId`                                  |
| `sla-recovered`         | info     | SLA dimension が nominal に回復した。                                 | `dimension`, `scope`, `scopeId`, `recoveredAt`, `thresholdId`                            |
| `sla-threshold-changed` | info     | SLAThreshold レコードが登録または更新された。                         | `thresholdId`, `dimension`, `scope`, `scopeId`, `previousValue`, `newValue`, `changedBy` |

See also: [SLA Breach Detection](/reference/sla-breach-detection).

## Cost / quota events

| Event                       | Severity | Description                                                       | Payload fields                                                              |
| --------------------------- | -------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `space-attribution-changed` | notice   | Space の CostAttributionConfig が更新された。                     | `spaceId`, `previousAttributionDigest`, `newAttributionDigest`, `changedBy` |
| `quota-tier-registered`     | notice   | QuotaTier が登録された。                                          | `tierId`, `dimensions`, `registeredBy`                                      |
| `quota-tier-updated`        | notice   | QuotaTier の dimensions または rate-limit override が更新された。 | `tierId`, `previousDigest`, `newDigest`, `changedBy`                        |
| `quota-tier-removed`        | warning  | QuotaTier が registry から削除された。                            | `tierId`, `removedBy`, `reason`                                             |
| `space-tier-changed`        | notice   | Space に割当てられた QuotaTier が変更された。                     | `spaceId`, `previousTierId`, `newTierId`, `changedBy`                       |

See also: [Quota Tiers](/reference/quota-tiers),
[Cost Attribution](/reference/cost-attribution).

## Workflow Events

The kernel does not reserve trigger, declarable-hook, or step-execution audit
events. Workflow / cron / hook systems above the kernel own their own audit
event vocabulary; see
[Workflow Placement Rationale](/reference/architecture/workflow-extension-design).

## See also

- [Actor / Organization Model](/reference/actor-organization-model)
- [API Key Management](/reference/api-key-management)
- [Auth Providers](/reference/auth-providers)
- [RBAC Policy](/reference/rbac-policy)
- [Tenant Provisioning](/reference/tenant-provisioning)
- [Tenant Export / Deletion](/reference/tenant-export-deletion)
- [Trial Spaces](/reference/trial-spaces)
- [Quota Tiers](/reference/quota-tiers)
- [Cost Attribution](/reference/cost-attribution)
- [SLA Breach Detection](/reference/sla-breach-detection)
- [Incident Model](/reference/incident-model)
- [Support Impersonation](/reference/support-impersonation)
- [Notification Emission](/reference/notification-emission)
- [Zone Selection](/reference/zone-selection)

## Related architecture notes

- `reference/architecture/policy-risk-approval-error-model` — closed risk and
  approval enums referenced by Approval events.
- `reference/architecture/operation-plan-write-ahead-journal-model` — WAL stage
  enum referenced by Operation events.
- `reference/architecture/snapshot-model` — Snapshot semantics referenced by
  Activation events.
- `reference/architecture/operator-boundaries` — actor identity model and
  redaction trust boundary.

## 関連ページ

- [Storage Schema](/reference/storage-schema)
- [Journal Compaction](/reference/journal-compaction)
- [Connector Contract](/reference/connector-contract)
- [Actor / Organization Model](/reference/actor-organization-model)
- [API Key Management](/reference/api-key-management)
- [Auth Providers](/reference/auth-providers)
- [RBAC Policy](/reference/rbac-policy)
- [Tenant Provisioning](/reference/tenant-provisioning)
- [Tenant Export / Deletion](/reference/tenant-export-deletion)
- [Trial Spaces](/reference/trial-spaces)
- [Quota Tiers](/reference/quota-tiers)
- [Cost Attribution](/reference/cost-attribution)
- [SLA Breach Detection](/reference/sla-breach-detection)
- [Incident Model](/reference/incident-model)
- [Support Impersonation](/reference/support-impersonation)
- [Notification Emission](/reference/notification-emission)
- [Zone Selection](/reference/zone-selection)
