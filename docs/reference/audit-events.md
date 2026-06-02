# 監査イベント {#audit-events}

::: info
内部設計メモ。public contract は [Installer API](./installer-api.md) を参照。
:::

Takosumi audit events cover install / deploy / rollback lifecycle の Deployment の記録。Reference/operator extension event families can add リソースの作成・更新、runtime handler、and asset の記録。

## 共通 envelope

```ts
interface AuditLogEvent {
  id: string;
  type: string;
  severity: "debug" | "info" | "notice" | "warning" | "critical";
  occurredAt: string;
  spaceId?: string;
  installationId?: string;
  deploymentId?: string;
  actorRef?: string;
  payload: Record<string, unknown>;
  previousHash?: string;
  hash?: string;
}
```

`payload` は event type ごとの object です。secret value、raw token、 backend credential は reference / redacted form で扱います。

## Event type

この表は frequently consumed event type の索引です。Bootstrap と backup / restore の stage-specific event はそれぞれ [Bootstrap Protocol](./bootstrap-protocol.md) と [Backup and Restore](./backup-restore.md) が正本です。

### Installation / Deployment

| Type                             | Severity | 説明                                               |
| -------------------------------- | -------- | -------------------------------------------------- |
| `installation-dry-run-requested` | info     | 新規 Installation dry-run が要求された。           |
| `installation-created`           | notice   | Installation が作成された。                        |
| `deployment-dry-run-requested`   | info     | 既存 Installation の deploy dry-run が要求された。 |
| `deployment-started`             | notice   | Deployment apply が始まった。                      |
| `deployment-activated`           | notice   | Deployment が current active になった。            |
| `deployment-failed`              | warning  | Deployment が失敗した。                            |
| `rollback-requested`             | warning  | rollback が要求された。                            |
| `rollback-completed`             | notice   | retained Deployment への rollback が完了した。     |

### Reference Lifecycle / Backend Operation

| Type                  | Severity | 説明                                                    |
| --------------------- | -------- | ------------------------------------------------------- |
| `operation-planned`   | info     | OperationPlan が作成された。                            |
| `operation-started`   | info     | backend operation が開始された。                        |
| `operation-committed` | info     | backend operation が commit point を越えた。            |
| `operation-recovered` | notice   | journal replay / recovery により operation が復旧した。 |
| `operation-failed`    | warning  | backend operation が失敗した。                          |

### Reference / Operator Policy Events

These events belong to a reference/operator policy profile. They are not additional Source metadata fields and do not expand the portable Installer API entity model.

| Type                       | Severity | 説明                                                    |
| -------------------------- | -------- | ------------------------------------------------------- |
| `approval-required`        | notice   | apply に operator approval が必要になった。             |
| `approval-granted`         | notice   | approval が承認された。                                 |
| `approval-invalidated`     | warning  | approval が input drift などで無効化された。            |
| `cleanup-backlog-created`  | warning  | revoke が即時完了せず CleanupBacklog が記録された。     |
| `cleanup-backlog-resolved` | notice   | CleanupBacklog が解消された。                           |
| `drift-detected`           | warning  | observed state と desired state の drift が検出された。 |

### Reference asset / Runtime handler

| Type                       | Severity | 説明                                          |
| -------------------------- | -------- | --------------------------------------------- |
| `artifact-uploaded`        | info     | optional asset が受け付けられた。             |
| `artifact-gc-marked`       | info     | asset GC が live set を mark した。           |
| `artifact-gc-swept`        | notice   | asset GC が unreferenced asset を削除した。   |
| `runtime-handler-registered`     | notice   | runtime-agent runtime handler が登録された。        |
| `runtime-handler-replaced`       | notice   | runtime-agent runtime handler record が置換された。 |
| `runtime-handler-revoked`        | notice   | runtime-agent runtime handler が無効化された。      |
| `runtime-handler-health-changed` | warning  | runtime handler health が変化した。                 |
| `journal-compacted`        | info     | WAL base snapshot digest pair が更新された。  |

## Redaction

- secret value、raw token、private key、backend credential は記録しない。
- URL や object key に secret が含まれる可能性がある場合は digest にする。
- payload に source content 全体を埋めず、digest / size / source ref を記録する。

## Hash chain

audit store は event hash chain または同等の tamper-evident 方式を持ちます。 implementation は backend に合わせて構いませんが、operator が chain break を検知できる必要があります。

## 関連ページ

- [Storage Schema](./storage-schema.md)
- [Lifecycle Protocol](./lifecycle.md)
- [asset GC](./data-asset-gc.md)
- [Risk Taxonomy](./risk-taxonomy.md)
- [Approval Invalidation](./approval-invalidation.md)
