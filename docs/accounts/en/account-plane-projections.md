# Account Management Projections {#account-plane-projections}

Takosumi keeps account-facing projection records around Takosumi
Installation / Deployment records.

## Projection Boundary

| Record or value | Owner |
| --- | --- |
| Source identity / current Deployment pointer / status / outputs | Takosumi |
| Account ownership / billing owner / launch token | Takosumi |
| PlatformService binding choice / access policy | Takosumi |
| Provider object id / OpenTofu state / raw backend response | operator-private evidence |

Projections reference Deployment `planSnapshotDigest` and `bindingsSnapshot`.
Raw secrets are never included in public responses or export bundles.
