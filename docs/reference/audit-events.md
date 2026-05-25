# 監査イベント {#audit-events}

Takosumi core audit events cover install / deploy / rollback lifecycle evidence.
Reference/operator extension event families can add provider operation,
connector, and DataAsset evidence. account、billing、support、 customer
onboarding の event taxonomy は operator account-plane 側で定義します。

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

`payload` は event type ごとの object です。secret value、raw token、 provider
credential は reference / redacted form で扱います。

## Event type

この表は frequently consumed event type の索引です。Bootstrap と backup /
restore の stage-specific event はそれぞれ
[Bootstrap Protocol](./bootstrap-protocol.md) と
[Backup and Restore](./backup-restore.md) が正本です。

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

### Reference Lifecycle / Provider Operation

| Type                  | Severity | 説明                                                    |
| --------------------- | -------- | ------------------------------------------------------- |
| `operation-planned`   | info     | OperationPlan が作成された。                            |
| `operation-started`   | info     | provider operation が開始された。                       |
| `operation-committed` | info     | provider operation が commit point を越えた。           |
| `operation-recovered` | notice   | journal replay / recovery により operation が復旧した。 |
| `operation-failed`    | warning  | provider operation が失敗した。                         |

### Policy / safety

| Type                   | Severity | 説明                                                    |
| ---------------------- | -------- | ------------------------------------------------------- |
| `approval-required`    | notice   | apply に operator approval が必要になった。             |
| `approval-granted`     | notice   | approval が承認された。                                 |
| `approval-invalidated` | warning  | approval が input drift などで無効化された。            |
| `revoke-debt-created`  | warning  | revoke が即時完了せず RevokeDebt が記録された。         |
| `revoke-debt-resolved` | notice   | RevokeDebt が解消された。                               |
| `drift-detected`       | warning  | observed state と desired state の drift が検出された。 |

### Reference DataAsset / Connector

| Type                       | Severity | 説明                                                |
| -------------------------- | -------- | --------------------------------------------------- |
| `artifact-uploaded`        | info     | optional DataAsset が受け付けられた。               |
| `artifact-gc-marked`       | info     | DataAsset GC が live set を mark した。             |
| `artifact-gc-swept`        | notice   | DataAsset GC が unreferenced DataAsset を削除した。 |
| `connector-registered`     | notice   | runtime-agent connector が登録された。              |
| `connector-replaced`       | notice   | runtime-agent connector record が置換された。       |
| `connector-revoked`        | notice   | runtime-agent connector が無効化された。            |
| `connector-health-changed` | warning  | connector health が変化した。                       |
| `journal-compacted`        | info     | WAL base snapshot digest pair が更新された。        |

## Redaction

- secret value、raw token、private key、provider credential は記録しない。
- URL や object key に secret が含まれる可能性がある場合は digest にする。
- payload に source content 全体を埋めず、digest / size / source ref
  を記録する。

## Hash chain

audit store は event hash chain または同等の tamper-evident 方式を持ちます。
implementation は backend に合わせて構いませんが、operator が chain break を検知
できる必要があります。

## 関連ページ

- [Storage Schema](./storage-schema.md)
- [Lifecycle Protocol](./lifecycle.md)
- [DataAsset GC](./data-asset-gc.md)
- [Risk Taxonomy](./risk-taxonomy.md)
- [Approval Invalidation](./approval-invalidation.md)
