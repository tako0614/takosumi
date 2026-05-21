# 監査イベント {#audit-events}

Takosumi kernel の audit event は installer / deployment / provider operation の
証跡です。account、billing、support、customer onboarding の event taxonomy は
operator account-plane 側で定義します。

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

`payload` は event type ごとの object です。secret value、raw token、
provider credential は payload に含めません。

## Event type

### Installation / Deployment

| Type | Severity | 説明 |
| --- | --- | --- |
| `installation-dry-run-requested` | info | 新規 Installation dry-run が要求された。 |
| `installation-created` | notice | Installation が作成された。 |
| `deployment-dry-run-requested` | info | 既存 Installation の deploy dry-run が要求された。 |
| `deployment-started` | notice | Deployment apply が始まった。 |
| `deployment-activated` | notice | Deployment が current active になった。 |
| `deployment-failed` | warning | Deployment が失敗した。 |
| `rollback-requested` | warning | rollback が要求された。 |
| `rollback-completed` | notice | rollback Deployment が完了した。 |

### Lifecycle / provider operation

| Type | Severity | 説明 |
| --- | --- | --- |
| `operation-planned` | info | OperationPlan が作成された。 |
| `operation-started` | info | provider operation が開始された。 |
| `operation-committed` | info | provider operation が commit point を越えた。 |
| `operation-recovered` | notice | journal replay / recovery により operation が復旧した。 |
| `operation-failed` | warning | provider operation が失敗した。 |

### Policy / safety

| Type | Severity | 説明 |
| --- | --- | --- |
| `approval-required` | notice | apply に operator approval が必要になった。 |
| `approval-granted` | notice | approval が承認された。 |
| `approval-invalidated` | warning | approval が input drift などで無効化された。 |
| `revoke-debt-created` | warning | revoke が即時完了せず RevokeDebt が記録された。 |
| `revoke-debt-resolved` | notice | RevokeDebt が解消された。 |
| `drift-detected` | warning | observed state と desired state の drift が検出された。 |

### Artifact / catalog / connector

| Type | Severity | 説明 |
| --- | --- | --- |
| `artifact-uploaded` | info | artifact が受け付けられた。 |
| `artifact-gc-marked` | info | artifact GC が live set を mark した。 |
| `artifact-gc-swept` | notice | artifact GC が不要 artifact を削除した。 |
| `catalog-release-adopted` | notice | catalog release が採用された。 |
| `connector-registered` | notice | runtime-agent connector が登録された。 |
| `connector-health-changed` | warning | connector health が変化した。 |

## Redaction

- secret value、raw token、private key、provider credential は記録しない。
- URL や object key に secret が含まれる可能性がある場合は digest にする。
- payload に source content 全体を埋めず、digest / size / source ref を記録する。

## Hash chain

audit store は event hash chain または同等の tamper-evident 方式を持ちます。
implementation は backend に合わせて構いませんが、operator が chain break を検知
できる必要があります。

## 関連ページ

- [Storage Schema](./storage-schema.md)
- [Lifecycle Protocol](./lifecycle.md)
- [Artifact GC](./artifact-gc.md)
- [Risk Taxonomy](./risk-taxonomy.md)
- [Approval Invalidation](./approval-invalidation.md)
