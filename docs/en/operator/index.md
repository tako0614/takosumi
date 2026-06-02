# Operator {#operator}

An operator runs Takosumi and decides which PlatformServices and runtime
implementations a Source binds to. Accounts, billing, OIDC, approvals,
dashboards, OpenTofu state, and provider credentials belong to the
operator distribution.

## Prerequisites

- Source / Installation / Deployment lifecycle
- Installer API dry-run / apply / rollback
- PlatformService inventory and `BindingSelection`
- source handoff (`git` / `prepared` / `local`)
- runtime targets, storage, secret stores, backup / restore

## Reading Order

1. [Concepts](../getting-started/concepts.md)
2. [Specification Boundaries](../reference/spec-boundaries.md)
3. [Installer API](../reference/installer-api.md)
4. [Platform Services](../reference/platform-services.md)
5. [Build Service Boundary](../reference/build-spec.md)
6. [Build Service Example](./build-service-profile.md)
7. [Takosumi Entry](../reference/accounts.md)

## Operator Decisions

| Area                 | Examples                                                               |
| -------------------- | ---------------------------------------------------------------------- |
| source intake        | git source, prepared artifact, dev / operator-local source             |
| PlatformService      | runtime target, database, object store, queue, OIDC issuer, MCP endpoint |
| binding policy       | default binding, approval, quota, access mode, visibility              |
| state / secret store | Postgres, D1, KMS, secret encryption, backup / restore                 |
| infrastructure state | OpenTofu state, provider credentials, locks                  |
| account surface      | signup, billing, team, dashboard, deploy facade                        |
| runtime execution    | container, worker, VM, local process, runtime-agent connector          |

Takosumi records those selections as Deployment `bindingsSnapshot` and
`outputs`. Infrastructure creation and provider state stay operator-owned.

## Related Pages

- [Installer API](../reference/installer-api.md)
- [Platform Services](../reference/platform-services.md)
- [Build Service Boundary](../reference/build-spec.md)
- [HTTP Exposure](../reference/http-exposure.md)
