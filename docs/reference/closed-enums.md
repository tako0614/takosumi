# 閉じた enum {#closed-enums}

このページは Takosumi kernel contract で値集合を閉じる enum の索引です。operator
account-plane が所有する role、billing、trial、support、incident などの enum は
ここに含めません。

## Lifecycle

### Lifecycle phase

```txt
validate | plan | prepare | apply | verify | activate | observe | rollback | destroy | recover
```

### Lifecycle status

```txt
pending | running | succeeded | failed | skipped | cancelled
```

### Operation kind

```txt
create | update | replace | delete | no-op | rollback
```

## WAL stage

```txt
planned | prepared | pre-commit | committed | verified | activated | compensated | failed
```

WAL stage の意味は [WAL Stages](./wal-stages.md) を参照してください。

## Access mode

```txt
read | read-write | admin | invoke-only | observe-only
```

詳細は [Access Modes](./access-modes.md) を参照してください。

## Approval lifecycle

```txt
not-required | pending | approved | rejected | invalidated | expired
```

approval が無効化される条件は
[Approval Invalidation](./approval-invalidation.md) にあります。

## Risk

Risk enum は [Risk Taxonomy](./risk-taxonomy.md) が canonical source
です。代表的な category は次の通りです。

```txt
destructive-change | credential-exposure | network-exposure | quota-exhaustion |
provider-drift | approval-required | unsupported-capability
```

## RevokeDebt

### reason

```txt
permission-drift | secret-rotation | provider-delete-failed | link-detach-failed | policy-revoked
```

### status

```txt
open | retrying | resolved
```

詳細は [RevokeDebt Model](./revoke-debt.md) を参照してください。

## DataAsset kind

```txt
source-archive | build-output | runtime-bundle | static-asset | export-archive
```

artifact の扱いは [DataAsset Policy](./data-asset-policy.md) と
[Artifact GC](./artifact-gc.md) を参照してください。

## Health

```txt
unknown | healthy | degraded | unhealthy
```

connector / runtime observation の health value です。

## Domain error code

```txt
invalid_argument | unauthenticated | permission_denied | not_found |
already_exists | conflict | failed_precondition | resource_exhausted |
cancelled | unavailable | internal
```

HTTP status への対応は [Kernel HTTP API](./kernel-http-api.md) にあります。

## Connector identity

```txt
connector:<provider-id>
```

connector id は runtime-agent connector を識別します。詳細は
[Connector Contract](./connector-contract.md) を参照してください。

## 関連ページ

- [Lifecycle Protocol](./lifecycle.md)
- [WAL Stages](./wal-stages.md)
- [Kernel HTTP API](./kernel-http-api.md)
- [Risk Taxonomy](./risk-taxonomy.md)
- [Connector Contract](./connector-contract.md)
