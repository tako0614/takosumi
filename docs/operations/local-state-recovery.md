# Commit one approved local state-recovery artifact

This is an explicit Bun/Postgres operator command for an already staged initial-create recovery artifact.
It authenticates a local Unix **OS account**, consumes one private case approval and calls the existing state-only Core primitive.
It does not establish the unknown Host operation's outcome, stage state bytes, run a provider, publish Output, or turn the failed Apply into success.

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
The command creates no schema, migrations, artifact root, approval or keys.

## Private case approval

The only command argument is a bounded case ID. It selects `<case-id>.json` inside the configured approval directory; a caller cannot pass a profile path, state bytes, arbitrary artifact URL or another recovery identity.
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
