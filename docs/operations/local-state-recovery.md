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

## Private Worker composition (unmounted)

The portable Worker operator source has no default mount, public HTTP route,
deploy catalog entry or configured production approval authority. It does not reuse the Unix
approval files above, an Accounts identity-merge approval, session/admin role or
deploy control token. The owner must supply a separately qualified private
authority and actual selected-target D1/R2/key/storage custody.

An owner alternate module can export a named class using
`composePrivateStateRecoveryWorker<OwnerEnv>(env => createPrivateR2StateRecoveryOperator(...))`
from `worker/src/private-state-recovery-worker.ts` and
`worker/src/private-state-recovery.ts`. The lexical owner closure provides the
real environment bindings to `openBindings`; it does not place an in-process
function object into a Cloudflare binding. The resulting RPC prototype exposes
`stageRecoveryState`, `commitRecoveryState` and a fetch handler returning 404.
No normal Worker, Platform or Hosted export or configuration selects this class.

The factory takes a fixed `selectedTargetId`, a
`QualifiedStateRecoveryApprovalPort` and lazy `openBindings`. Bindings include the
actual database/bucket, `cryptoEnv` and an explicit `storageProfile`: `oss-r2`,
`artifact-retention` with its capability, or `stored-service` with both existing
custody capabilities. Missing or unsupported profiles cannot silently become
unmetered OSS custody. Only existing encryption key/partition-key fields are
forwarded; development-placeholder flags are ignored and a missing key refuses
before ledger/R2 access. D1 uses `predeployed` verification only. Prepare the
current schema separately; this entry performs no bootstrap migration.

The only stage request fields are `{ approvalRef, plaintext: Uint8Array }`; the
bounded raw bytes are copied before awaiting the authority. Commit accepts only
`{ approvalRef }`. Scope, stable actor and command identity come from the
qualified port's closed approved record, never caller-supplied IDs or roles.
`approvalRef` is a locator for a private proof: the authority must authenticate
its holder/channel, current effect, purpose and revocation. A public case-ID
lookup or possession of a named Service Binding alone is insufficient.

Both approval records use `format: takosumi.private-worker-state-recovery-approval/v1`
and contain exactly `purpose`, `approvedOperatorId`, `selectedTargetId`,
`workspaceId`, `capsuleId`, `environment`, `failedApplyRunId`, `recoveryRunId`,
`sourceSnapshotId`, `commandTimestamp`, `expiresAt`, `plaintextSha256` and
`custodyEvidenceDigest`, plus that format. Stage purpose is
`stage-initial-create-state`. Commit purpose is
`commit-staged-initial-create-state` and additionally binds `artifactHandle`,
`encryptedDigest` and `evidenceDigest`. The qualified authority issues the two
approvals separately. A stage receipt has a different format/purpose and cannot
be passed back as commit authority.

Invalid, absent, expired or changed approval refuses with the value-free
`private_state_recovery_refused` error. Approval is reread before resource
access and around artifact/ledger operations. Stage checks the current failed
initial create, gen0/error/no Output, pinned snapshot and observed authority;
it changes no ledger. The existing encrypted R2 adapter preserves the original
immutable object on exact retry. Commit checks approved plaintext/custody and
actual ciphertext/evidence digests before retention acknowledgement, then uses
the unchanged Core provenance/history/epoch CAS. Success returns only `status`,
`recoveryRunId`, `stateVersionId` and `capsuleId`; conflict returns only its status.

Approval rechecks and D1 commit are not atomic with one another. A lost response
or refusal after commit is an unknown acknowledgement, not evidence of no
effect. Retain the same approved actor, command timestamp, recovery identity and
artifact. A separately valid explicit retry can reconcile the exact commit;
there is no automatic retry or new recovery identity. The original Apply stays
failed, Capsule stays error, runtime stays unknown and no Output or execution
success evidence is produced.

## Signed private holder approvals

`worker/src/signed-state-recovery-approval.ts` supplies an explicit issuer helper
and a public-key-only reader for the private Worker port. This is a distinct
Worker state-recovery signature domain. Accounts identity-merge signatures,
session/admin roles and deploy tokens are not accepted. No real key, holder
handoff, current store, HTTP route or operational binding is configured.

The operator qualifies an independent P-256 key pair and its fixed `issuer`,
`keyId` and `selectedTargetId` out of band. The issuer takes only the explicit
private signing `CryptoKey`. The reader takes only the corresponding public
verification `CryptoKey`; it has neither a signing key nor issuer/admin binding.
Key rotation and public-key custody are operator configuration, not dynamic
discovery from a record.

Call `createSignedStateRecoveryApprovalIssuer({ issuer, keyId, selectedTargetId, signingKey })`,
then `issueStageApproval(reviewedStageApproval)` with the complete closed stage
record. After independently reviewing the staged result, explicitly call
`issueCommitApproval(reviewedCommitApproval)` with the complete closed commit
record. Neither method derives the second decision from a receipt or publishes
an active record. No key is generated or persisted by the helper.

Each explicit issuance generates a fresh 32-byte random holder proof. Its
private result is `{ approvalRef, holderProofDigest, record }`. Retain the original
proof privately and hand it only to the intended holder over the qualified
channel. Do not log it, place it in URLs or source, use a public case ID in its
place, or rerun issuance merely to retry a command. Only the domain-separated
digest enters the signed record and the trusted current lookup.

The record has exactly `format`, `payload` and `signature`. Its format is
`takosumi.worker.signed-state-recovery-approval/v1`. The bounded canonical JSON
payload contains the recovery-specific domain, `algorithm: ES256`, fixed issuer
and key ID, holder digest and the existing closed approval DTO. Its UTF-8 bytes
are signed with ECDSA P-256/SHA-256. The 64-byte signature and 32-byte proof use
canonical unpadded base64url. Unknown fields, noncanonical JSON/encodings and
cross-effect domains are refused.

The trusted owner separately installs the issued record under its digest in an
authoritative current store. The read-only
`readCurrentSignedStateRecoveryApproval({ holderProofDigest })` port returns
`{ status: "active", record }` only for the current active decision; revoked or
absent entries refuse. Never serve a cached superseded active decision.
Publication, revocation, storage/channel custody and persistence are separate
operator duties; this helper adds no database schema or implicit grant.

`createSignedStateRecoveryApprovalReader({ issuer, keyId, selectedTargetId, publicKey, currentLookup })`
implements the existing `QualifiedStateRecoveryApprovalPort`. For each call it
validates the private proof, awaits fresh lookup, snapshots signed scalar data,
verifies exact bytes and scope, then awaits a second fresh lookup and requires
the same active record and current expiry. There is no decision cache, signing
capability, fallback issuer or automatic retry. Raw proof never crosses the
current-lookup port.

The reader and existing operator revalidation do not make external revocation
and Core CAS atomic. A still-current proof can explicitly repeat only its fixed
command; Core reconciles the exact existing commit. A revoked or expired proof
does not authorize even that replay. Unknown acknowledgement handling and all
state-only safety limits above remain unchanged.
