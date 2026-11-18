# Stage and commit one approved local state-recovery artifact

This explicit Bun/Postgres operator command has separate stage-only and commit-only modes for one failed initial create.
Both authenticate a local Unix **OS account** and consume a purpose-specific private case approval.
Staging does not authorize a commit; neither mode establishes the unknown Host outcome, runs a provider, publishes Output, or turns the failed Apply into success.

## Preconditions and authority

Use the same selected Postgres ledger, local encrypted artifact root, allocator and encryption-key configuration that produced the staged artifact.
The existing `LocalOpenTofuStateRecoveryArtifactStore` must verify its opaque handle, ciphertext/readback and persisted Capsule storage identity.
An operator must separately establish where the recovered OpenTofu state came from and approve its custody evidence; an intact encrypted file alone does not prove that provenance.

The command runs as the operator's local Unix account. Real and effective UID must match, and the approval must name `local-unix-account:<uid>`.
This is not personal sign-in. If root or another shared/service account is used, every process with that account's privileges is inside this authority boundary.
Prefer a dedicated operator account; this command does not isolate processes sharing its UID.
An Accounts session, app owner, MCP token, generic deploy-control bearer or configuration presence alone grants no recovery permission.
There is no HTTP route, default server mount, Worker/R2 operator entry, or automatic invocation.

The operator selects these existing runtime settings privately:

- `TAKOSUMI_ACCOUNTS_DATABASE_URL` and the normal `TAKOSUMI_ACCOUNTS_PG_*` connection/TLS settings.
- `TAKOSUMI_LOCAL_STATE_ARTIFACT_DIR`, with the original partitioned secret-encryption configuration. Missing or placeholder crypto is refused; do not generate a replacement key.
- `TAKOSUMI_OPERATOR_STATE_RECOVERY_APPROVAL_DIR`: an absolute, owner-matched mode-0700 directory outside source checkouts.
- `TAKOSUMI_OPERATOR_STATE_RECOVERY_TARGET_ID`: the explicit selected runtime label bound by the case approval.

The target label prevents accidental selection of another configured label; it is not a database-instance, TLS, Host, or cross-host identity proof.
Preserve the separately qualified target and file/key cohort. Do not infer a genuine target from this label or a copied profile.
The command creates no schema, migrations, approval or keys. Commit mode creates no artifact.
Stage mode publishes only the selected encrypted artifact and a private result receipt through the existing local adapter.

## Stage an explicitly captured state

Use `--stage-case <case-id>` only after separately establishing the original state capture and approving its custody evidence.
The configured protected approval directory contains these fixed basenames:

- `<case-id>.stage.json`: the stage-only approval described below.
- `<case-id>.tfstate`: the explicitly supplied original capture, a single owner-matched 0600/0400 regular file with one link.
- `<case-id>.staged.json`: the immutable stage result receipt; do not pre-create it or treat it as commit approval.

These files use the same protected ancestry, descriptor/path snapshot checks, source-checkout exclusion and actual-UID boundary as commit approvals.
The raw capture is bounded by the adapter's existing 16 MiB state limit before allocation and read once without UTF-8 decode/re-encode.
Its SHA-256 includes the original bytes, including any BOM. Changed, missing, aliased, oversized or wrong-digest initial captures are refused.
Holding those checked bytes does not require the capture path to remain unchanged after the read.

The stage approval has exactly these fields (schema only, not an issued approval):

| Field | Required value |
| --- | --- |
| `format` | `takosumi.local-operator-state-stage/v1` |
| `purpose` | `stage-initial-create-state` |
| `caseId`, `approvedOperatorId`, `selectedTargetId` | Selected case, actual `local-unix-account:<uid>`, configured target label |
| `workspaceId`, `capsuleId`, `environment` | Exact approved failed initial-create scope |
| `failedApplyRunId`, `recoveryRunId`, `sourceSnapshotId` | Fixed failed Apply, distinct recovery identity and its pinned source snapshot |
| `commandTimestamp`, `expiresAt` | Fixed canonical UTC timestamp at/after the failed termination, and current admission expiry |
| `plaintextSha256` | `sha256:<64 lowercase hex>` of the supplied original raw capture |
| `custodyEvidenceDigest` | Operator-confirmed `sha256:<64 lowercase hex>` evidence reference; state content does not prove its provenance |

```sh
bun --no-env-file scripts/operator-state-recovery.ts --stage-case <approved-stage-case-id>
```

The entry checks approval before SQL/key access. Before staging it reads the exact failed create and its pinned Plan/snapshot, current generation-0 error Capsule with no state/output, current execution/management authority and a bounded newest-first page of related Runs. Known later/in-flight work or changed recorded authority is refused.
Incomplete history does not become a new admission rule: full history, Plan/input/config provenance, leases and atomic authority remain the unchanged Core commit's responsibility.
These filesystem and ledger reads are not one atomic operation. A later revocation/conflict can leave an encrypted artifact without a result receipt; it does not authorize a commit or overwrite that artifact.

The existing no-replace encrypted adapter validates state structure, exact scope and custody digests and decrypts its readback.
The result receipt has `format: takosumi.local-operator-state-stage-receipt/v1`, `purpose: staged-initial-create-state`, the approved binding except expiry, and `artifactHandle`, `encryptedDigest`, `evidenceDigest` from that actual verifier.
It contains no state bytes or credentials. Stdout reports only `status: staged` and `commitApprovalIssued: false` after the pool-close attempt; a close failure reports `connection_close_failed` and exits nonzero separately.

An exact retry while the original initial-failure scope remains eligible reuses an identical receipt by verified readback, without staging again or requiring the original capture path.
If artifact publication succeeded but no receipt exists, the same approved capture can reconcile the adapter's immutable exact artifact.
Conflicting state/evidence, a missing/replaced artifact behind an existing receipt, or a different receipt is refused; nothing is overwritten.
Once the Capsule generation/lineage has advanced, stage mode refuses; use the separately approved commit command's existing exact replay instead.

To proceed, an operator must explicitly issue the **separate v1 commit approval** below using the verified receipt's handle and three digests.
The producer never creates that approval, calls the commit primitive, changes the ledger generation, or infers missing custody evidence.

## Private case approval

Commit mode's only value argument is a bounded case ID. It selects `<case-id>.json` inside the configured approval directory; a caller cannot pass a profile path, state bytes, arbitrary artifact URL or another recovery identity.
The file must be a single regular, owner-matched, non-symlink file with one link and mode 0600 or 0400.
Every ancestor must be non-symlink, owned by root or the operator, and not group/world writable; the immediate approval directory must be owner-matched mode 0700.
The bounded reader checks the opened descriptor and path before and after reading. Profiles inside the source checkout are refused.

An approval has exactly these fields; values below describe the schema, not an issued approval:

| Field | Required value |
| --- | --- |
| `format` | `takosumi.local-operator-state-recovery/v1` |
| `purpose` | `commit-staged-initial-create-state` |
| `caseId` | The selected case ID |
| `approvedOperatorId` | The actual local OS account ID, `local-unix-account:<uid>` |
| `selectedTargetId` | The configured selected runtime label |
| `workspaceId`, `capsuleId`, `environment` | The exact approved artifact and failed Apply scope |
| `failedApplyRunId`, `recoveryRunId` | The exact existing failed initial Apply and fixed recovery identity |
| `commandTimestamp` | One canonical UTC ISO timestamp, fixed for every identical retry |
| `expiresAt` | Canonical UTC ISO expiry, later than the current admission time |
| `artifactHandle` | The original local adapter's opaque staged handle |
| `plaintextSha256`, `encryptedDigest`, `evidenceDigest` | The verified state, ciphertext and custody-evidence digests |

Unknown fields, future command timestamps, expired approvals, identity/target mismatches and artifact mismatches are refused.
The fixed command timestamp must be at or after the actual failed Apply's recorded terminal time; missing or malformed terminal evidence is refused.
Keep the fixed command timestamp: Core's exact replay compares the complete recovery Run and Activity records.
Changing it, creating another recovery Run, using another key or fabricating a runner receipt is not ACK recovery.

## Explicit invocation and result

With the protected configuration and case approval already supplied, invoke the selected source once:

```sh
bun --no-env-file scripts/operator-state-recovery.ts --case <approved-case-id>
```

Approval is checked before the database pool or artifact is accessed, reread for the commit attempt and revalidated around actual artifact verification.
Expiry is an admission check; the filesystem approval and the database commit are not one atomic transaction.
The existing Core ledger CAS still fences the exact Capsule, failed Apply, pinned Plan/SourceSnapshot, management and execution epochs, and state/activity identities.
The command stages nothing and dispatches no runner or Host request.

After successful connection closure, success returns `status: completed` with a nested `recovery` result (`committed` or `replayed`) and recovery Run, StateVersion and Capsule IDs. Conflict returns a bounded conflict result and nonzero exit.
Other refusals print `local_state_recovery_refused` and exit nonzero; private configuration, handles, keys, state bytes and raw database errors are not printed.
The command awaits pool closure before publishing completion. A close failure returns `status: connection_close_failed`, preserves any known `recovery` outcome separately, prints the bounded close-failure code, and exits nonzero. It does not turn a known commit into a refusal or claim connection cleanup succeeded. No automatic retry is performed.

For a lost commit ACK, retain the same approval, fixed command timestamp, recovery identity and artifact. An explicitly repeated valid case can reconcile the existing exact commit.
If approval has expired, seek an explicit renewal retaining the same command identity rather than changing timestamps or creating another Run.
An unknown acknowledgement is not proof that the database did not commit.

After state-only commit, the original Apply remains failed, Capsule remains error, runtime outcome/inventory remain unknown, and no Output or runner-success evidence is invented.
Use the existing reviewed Destroy/lineage path where appropriate; ordinary Apply/update is still constrained by the unknown outcome.
This command does not complete Host pre-ACK reconciliation or authorize a deployed environment by itself.
