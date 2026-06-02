# Takosumi Distribution Contract v1 {#takosumi-contract-v1}

Takosumi は Takosumi の reference operator distribution です。Cloud
compatibility は、Takosumi の Source / Installation / Deployment /
Installer API を account-facing surface と provider operation に接続する contract
です。

## Layer Boundary

| Surface | Owner | Cloud contract |
| --- | --- | --- |
| Source / Installation / Deployment | Takosumi | Cloud は record を account-facing projection に写す |
| Installer API | Takosumi | Takosumi Accounts deploy facade が approval / auth を付けて呼ぶ |
| PlatformService inventory | Takosumi | Space-visible service capability と binding policy を定義する |
| Accounts / OIDC / billing / dashboard | Takosumi | user / team / billing / login / launch behavior を定義する |
| Provider state / OpenTofu | Takosumi / operator | state、lock、credential、evidence を保持する |

## Compatibility Surface

- account と Space ownership record
- account session と personal access token authorization
- account-facing Installation projection ledger
- PlatformService inventory for identity, billing, runtime, storage, and MCP
- OIDC issuer と per-Installation OIDC client
- billing owner、portal、usage reporting
- dashboard / deploy facade
- launch token issue / consume semantics
- export/import archive behavior and redaction rules

## Projection Ledger

Cloud projection record は Takosumi Installation / Deployment の周辺 record です。
authority は次のように分かれます。

| Value | Authority |
| --- | --- |
| source identity / current Deployment pointer / status / outputs | Takosumi |
| account owner / billing owner / launch token / dashboard state | Takosumi |
| provider object id / OpenTofu state / credential ref | operator-private evidence |

Cloud は Deployment の `planSnapshotDigest` と `bindingsSnapshot` を参照し、account
view、approval history、export/import continuity を説明します。
