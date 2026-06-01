# Access Modes {#access-modes}

Access modes describe the strength of permission attached to a PlatformService
binding in the operator catalog. Takosumi core treats the enum as recorded wire
data; operator policy decides which binding may receive which access.

```text
read | read-write | admin | invoke-only | observe-only
```

## Meaning

| Mode           | Meaning                                                                  |
| -------------- | ------------------------------------------------------------------------ |
| `read`         | Allows state / metadata reads only. No mutation credential is delivered. |
| `read-write`   | Allows reads and mutations on the primary state surface.                 |
| `admin`        | Includes provider management operations. Never a default; approval-grade. |
| `invoke-only`  | Allows calls through an invocation surface, not direct stored-state reads. |
| `observe-only` | Allows metrics / events / notifications only.                            |

## Resolution

Access mode is not written in a Takosumi source DSL. The operator catalog
resolver chooses it from:

- install / deploy request `BindingSelection`
- account-plane UI selection
- operator policy pack
- PlatformService inventory safe defaults
- approval workflow result

Resolved access is stored in Deployment `bindingsSnapshot`. `read-write` and
`admin` require explicit selection or approval.

## Related Pages

- [Platform Services](./platform-services.md)
- [Installer API](./installer-api.md)
