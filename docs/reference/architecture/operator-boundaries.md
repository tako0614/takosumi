# Operator Boundaries {#operator-boundaries}

operator は採用した semantic world / implementation world / credential / Space
構成 / 本番安全境界を制御します。

## Operator-Controlled Areas {#operator-controlled-areas}

```text
Space creation, deletion, and membership
PlatformService inventory and visibility
Future cross-Space service sharing policy
Backend adapter attachment and credentials
OpenTofu state and provider locks
Profile and policy packs
Secret store and Space partitions
Runtime / runtime handler credentials
Optional asset API policy and Space visibility
Public API enablement
Audit and observability
Production coordination
```

Takosumi records Source, Installation, Deployment, plan snapshot, binding
snapshot, outputs, and status. Operator-owned PlatformService inventory and
account-plane projection explain which external services were selected and who
can use them.

## Space Administration {#space-administration}

Space は operator が統治する isolation 境界です。operator は次を定義します。

```text
who can install / deploy into the Space
which PlatformServices are visible and authorized
which policy pack applies
which secrets and optional assets are visible
which runtime profiles are available
which groups exist or may be created
```

Source は Space を作成・設定しません。

## Source And Implementation Code {#source-and-implementation-code}

Source repository metadata is generic: Git URL, commit, tag, and `package.json`
where available. A repository does not select providers with a Takosumi-specific
source DSL. Implementation binding is configured by the operator distribution.

## Credential Boundary {#credential-boundary}

Takosumi canonical state stores references and handles, not raw secret values.
External I/O and credentials stay inside implementation / runtime handler / runtime
boundaries. Secret partitions are Space-scoped unless operator policy explicitly
shares them.

## Runtime handler Boundary {#runtime-handler-boundary}

runtime handlers are installed and managed by the operator. [Runtime Handler Guide](../runtime-handler-contract.md)
describes the reference runtime handler inventory. Runtime handler visibility and accepted
asset metadata are operator-governed and Space-scoped.

## Production Mode {#production-mode}

Production must fail closed when required operator ports, PlatformServices,
adapter bindings, or Space policy are absent. Production must not silently accept
dev fallbacks.

## Cross-Space Service Sharing {#cross-space-service-sharing}

Space を跨ぐ service sharing は future RFC scope です。current v1 は Space-local
PlatformService inventory と operator policy visibility を基本にします。
