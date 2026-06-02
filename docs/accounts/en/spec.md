# Takosumi Distribution Contract v1 {#takosumi-contract-v1}

Takosumi is the reference operator distribution for Takosumi. Cloud
compatibility is the contract that connects Takosumi Source /
Installation / Deployment / Installer API records to account-facing surfaces and
provider operations.

## Layer Boundary

| Surface | Owner | Cloud contract |
| --- | --- | --- |
| Source / Installation / Deployment | Takosumi | Cloud projects Takosumi records into account-facing records. |
| Installer API | Takosumi | Takosumi Accounts deploy facade calls it with approval and authorization. |
| PlatformService inventory | Takosumi | Cloud defines Space-visible capabilities and binding policy. |
| Accounts / OIDC / billing / dashboard | Takosumi | Cloud defines user, team, billing, login, and launch behavior. |
| Provider state / OpenTofu | Takosumi / operator | Cloud stores state, locks, credentials, and evidence. |

## Compatibility Surface

- account and Space ownership records
- account session and personal access token authorization
- account-facing Installation projection ledger
- PlatformService inventory for identity, billing, runtime, storage, and MCP
- OIDC issuer and per-Installation OIDC clients
- billing owner, portal, and usage reporting
- dashboard and deploy facade
- launch token issue / consume semantics
- export/import archive behavior and redaction rules

## Projection Ledger

Cloud projection records surround Takosumi Installation / Deployment records.
Authority is split as follows.

| Value | Authority |
| --- | --- |
| source identity / current Deployment pointer / status / outputs | Takosumi |
| account owner / billing owner / launch token / dashboard state | Takosumi |
| provider object id / OpenTofu state / credential ref | operator-private evidence |

Cloud references Deployment `planSnapshotDigest` and `bindingsSnapshot` to
explain account views, approval history, and export/import continuity.
