# Enum and Value Index {#closed-enums}

Installer API、official catalog、reference implementation、operator extension
で使う enum / open value 索引。

Public Installer API の entity / error enum は
[Installer API](./installer-api.md) が正本です。このページは隣接する reference
Takosumi / operator implementation の internal enum も一緒に索引します。

## Public Installer API enums

Installation / Deployment status、Installer API エラーレスポンス、dry-run
response shape は [Installer API](./installer-api.md) が normative source です。この
ページでは重複定義しません。

## Reference / operator values

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

`LifecycleStatus` は reference runtime-agent envelope 内で closed な managed
object observation です。Deployment / Installation status は
[Installer API](./installer-api.md#entity-fields) が正本です。

### Operation kind

```txt
create | update | replace | delete | no-op | rollback
```

## WAL stage

```txt
prepare | pre-commit | commit | post-commit | observe | finalize | abort | skip
```

WAL stage の意味は [WAL Stages](./wal-stages.md) 参照。

## Operator access metadata

### Access mode

```txt
read | read-write | admin | invoke-only | observe-only
```

Access mode は official catalog vocabulary です。core は resolved value を
Deployment の記録に残し、operator profile が policy を enforce します。manifest
の dependency expression は `publish` / `listen` とプラットフォームサービス path
参照で表します。詳細は [Access Modes](./access-modes.md) 参照。

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

## CleanupBacklog

### reason

```txt
external-revoke | link-revoke | activation-rollback | approval-invalidated
```

### status

```txt
open | operator-action-required | cleared
```

詳細は [CleanupBacklog Model](./revoke-debt.md) 参照。

## Open operator values

### asset metadata value

asset metadata value は operator が optional asset extension の metadata
として登録する open value です。current compatibility wire では descriptor の
`kind` field と `acceptedArtifactKinds` field に現れますが、manifest component
`kind` とは別の operator extension metadata です。

asset の扱いは [asset Policy](./data-asset-policy.md) と
[asset GC](./data-asset-gc.md) 参照。

## Health

```txt
unknown | healthy | degraded | unhealthy
```

connector / runtime observation の reference value です。

## Domain error code

```txt
invalid_argument | unauthenticated | permission_denied | not_found |
failed_precondition | resource_exhausted | not_implemented |
readiness_probe_failed | internal_error
```

HTTP status への対応は reference Takosumi の
[Reference Takosumi Route Inventory](./kernel-http-api.md) にあります。Installer
API が返す public error code subset は
[Installer API](./installer-api.md#error-envelope) が正本です。

## Connector identity

```txt
connector:<id>
```

`connector:<id>` は current reference operator registry の compatibility wire
format です。ユーザー manifest が mint / address する値ではありません。
runtime-agent lifecycle dispatch key は `(shape, provider)` です。詳細は
[Connector Guide](./connector-contract.md) 参照。

## 関連ページ

- [Lifecycle Protocol](./lifecycle.md)
- [WAL Stages](./wal-stages.md)
- [Reference Takosumi Route Inventory](./kernel-http-api.md)
- [Risk Taxonomy](./risk-taxonomy.md)
- [Connector Guide](./connector-contract.md)
