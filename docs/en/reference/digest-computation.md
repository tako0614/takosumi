# Digest Computation {#digest-computation}

Takosumi v1 public guards are source identity and `planSnapshotDigest`.

| Digest / pin | Target | Use |
| --- | --- | --- |
| `commit` | Resolved git commit | git source guard |
| `sourceDigest` | Prepared source archive payload bytes | prepared source guard |
| `planSnapshotDigest` | Reviewed InstallPlan snapshot | dry-run to apply guard |
| `artifactDigest` | Operator extension artifact | operator/runtime-agent evidence |

`InstallPlan` is dry-run review data, not a persisted public entity. Apply records `planSnapshotDigest`, `planSnapshot`,
and `bindingsSnapshot` on Deployment.

For prepared source, the digest is over fetched archive payload bytes.
