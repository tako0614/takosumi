# 閉じた enum {#closed-enums}

このページは Takosumi kernel contract で値集合を閉じる enum の索引です。operator
account-plane が所有する role、billing、trial、support、incident などの enum は
account-plane docs に置きます。

## Lifecycle

### Lifecycle phase

```txt
apply | activate | destroy | rollback | recovery | observe
```

`verify` は lifecycle phase ではなく runtime-agent の補助 trigger です。

### Managed object LifecycleStatus

```txt
running | stopped | missing | error | unknown
```

Deployment / Installation status は
[Installer API](./installer-api.md#entity-fields) が正本です。

### Operation kind

```txt
create | update | replace | delete | no-op | rollback
```

## WAL stage

```txt
prepare | pre-commit | commit | post-commit | observe | finalize | abort | skip
```

WAL stage の意味は [WAL Stages](./wal-stages.md) を参照してください。

## Access mode

```txt
read | read-write | admin | invoke-only | observe-only
```

詳細は [Access Modes](./access-modes.md) を参照してください。

## Approval lifecycle

```txt
pending | approved | denied | expired | invalidated | consumed
```

approval が無効化される条件は
[Approval Invalidation](./approval-invalidation.md) にあります。 `reviewing` は
client-only UX hint として UI 側で扱います。

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

## Open operator values

### DataAsset metadata kind

DataAsset metadata `kind` は closed enum ではありません。operator が optional
DataAsset extension の metadata として登録する open value です。connector は
`acceptedArtifactKinds` で受け付ける metadata value を宣言します。

DataAsset の扱いは [DataAsset Policy](./data-asset-policy.md) と
[DataAsset GC](./artifact-gc.md) を参照してください。

## Health

```txt
unknown | healthy | degraded | unhealthy
```

connector / runtime observation の health value です。

## Domain error code

```txt
invalid_argument | unauthenticated | permission_denied | not_found |
failed_precondition | resource_exhausted | not_implemented |
readiness_probe_failed | internal_error
```

HTTP status への対応は [Kernel HTTP API](./kernel-http-api.md) にあります。
Installer API が返す public error code subset は
[Installer API](./installer-api.md#error-envelope) が正本です。

## Connector identity

```txt
connector:<id>
```

connector id は operator inventory identity です。runtime-agent lifecycle
dispatch key は `(shape, provider)` です。詳細は
[Connector Guide](./connector-contract.md) を参照してください。

## 関連ページ

- [Lifecycle Protocol](./lifecycle.md)
- [WAL Stages](./wal-stages.md)
- [Kernel HTTP API](./kernel-http-api.md)
- [Risk Taxonomy](./risk-taxonomy.md)
- [Connector Guide](./connector-contract.md)
