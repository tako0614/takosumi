# アカウント管理の投影 {#account-plane-projections}

Takosumi は Takosumi core Installation / Deployment record の周囲に
account-facing projection record を保持します。

## Projection Boundary

| Record or value | Owner |
| --- | --- |
| Source identity / current Deployment pointer / status / outputs | Takosumi core |
| Account ownership / billing owner / launch token | Takosumi |
| PlatformService binding choice / access policy | Takosumi |
| Provider object id / Terraform state / raw backend response | operator-private evidence |

projection は Deployment `planSnapshotDigest` と `bindingsSnapshot` を参照します。
raw secret は public response や export bundle に含めません。
