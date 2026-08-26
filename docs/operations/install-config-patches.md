# InstallConfig patch operation

Last updated: 2026-08-25

Use this operation when an app release publishes an immutable
`takosumi.install-config-patch@v1` contribution and the operator has already
selected the exact target InstallConfig row.

## Apply

1. Download the release asset from the operator-approved release. Verify its
   provenance and digest outside this command.
2. Choose the exact target InstallConfig id. For a pre-install template, use
   the reviewed shared config id; for an existing Capsule, read its exact
   `installConfigId`. Do not infer the target from the app name, Git URL, tag,
   or Store listing.
3. Review the JSON fields, lifecycle commands, executor, provider-credential
   opt-in, Output allowlist, and Interface binding proposals.
4. Apply the exact file:

   ```sh
   takosumi install-configs patch "$INSTALL_CONFIG_ID" \
     --file ./install-config-patch.json \
     --url "$TAKOSUMI_DEPLOY_CONTROL_URL" \
     --token "$TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
     --json
   ```

5. Read the returned InstallConfig and confirm its `updatedAt` revision/audit
   metadata, lifecycle policy, Output allowlist, and Interface blueprints
   before creating a new reviewed Plan.

The patch does not alter an already reviewed Plan. A later plan captures the
updated InstallConfig revision. It also does not download a release, discover a
repository manifest, update a Cloud reference config, or select an app/version
automatically.

## Capsule InstallConfig re-adoption (separate from patch)

When an existing Capsule must adopt a repository-owned InstallConfig discovered
from a current SourceSnapshot, use the dedicated re-adoption operation. Do not
patch the Capsule's current InstallConfig row or treat this as an install-plan
reconcile step.

1. As the Workspace owner/operator, read
   `GET /api/v1/capsules/{capsuleId}` and retain only the returned opaque
   `installConfigReAdoption.authorityGuard`. The private current InstallConfig
   digest is not needed.
2. Submit one closed request with a fresh `Idempotency-Key`:

   ```http
   POST /api/v1/capsules/{capsuleId}/install-config-re-adoptions
   Idempotency-Key: <opaque-key>
   Content-Type: application/json

   {
     "baseInstallConfigId": "<base-install-config-id>",
     "sourceSnapshotId": "<source-snapshot-id>",
     "reason": "<bounded non-secret reason>",
     "expected": { "authorityGuard": "<guard-from-capsule-get>" }
   }
   ```

   `deploymentProfileKey` may be included when the reviewed deployment profile
   requires it. Unknown fields, secret-like reasons, malformed guards, and
   missing idempotency keys fail before mutation.

3. On 200, re-read the Capsule and the returned target InstallConfig. The
   target is a new immutable derived row; the response is value-free and
   identifies the previous and target rows/digests and SourceSnapshot.
4. Create a new ordinary Plan, review it, and apply through the Run API. The
   re-adoption endpoint never runs provider infrastructure and never consumes
   or rewrites an existing Plan.

Normally, re-adoption is allowed only when `runtimeSafety` is `safe` or absent
(there is no decisive candidate). Unsafe or ambiguous Apply/Destroy/Restore
Runs, in-flight work, and an unconsumed Plan return 409; consumed or terminal
history does not block the operation.

The sole exception is a receipt-fenced committed `post_apply` recovery while
`runtimeSafety=unknown`. It requires the decisive failed `create`/`update`
ApplyRun to have exactly one ordered `apply.completed` → `apply.failed` receipt,
with `providerDispatched=true`, `providerApplySucceeded=true`, and terminal
`post_apply` lifecycle failure. The exact current `StateVersion` and `Output`
rows must match Capsule pointers, generation, workspace/capsule ownership,
environment, and failed-Apply provenance. The GET-issued guard and derived
target's private receipt are opaque, value-free evidence; receipt values never
appear in the public response.

The same CAS re-reads the latest decisive Run, exact StateVersion/Output rows,
whole current/target InstallConfig JSON, whole Capsule JSON, and execution
authority epoch. It requires no blocking queued/running Run or Apply and no
current unconsumed Plan. Missing or drifted receipt/Run/StateVersion/Output/
config/Capsule/epoch, provider uncertainty or persisted
`providerApplySucceeded=false` partial state, destroy/restore, a newer safety
candidate, in-flight Apply, or current unconsumed Plan returns 409. A successful
rebind changes only `installConfigId`, `updatedAt`, and epoch + 1;
`status=error`, state/output pointers, generation, and `runtimeSafety=unknown`
remain unchanged. The endpoint does not dispatch provider work. A fresh
reviewed Plan and Apply is required, and only its successful Apply may restore
the Capsule to `active` / `safe`.

A same-key, same-request retry replays the canonical target; a stale guard,
changed target, or changed request under the same key returns 409. Successful
rebind emits only value-free idempotency/activity evidence. Missing legacy Plan
epoch is accepted only at epoch 1; after a rebind it fails closed. The new epoch
is part of the Accounts OIDC activation digest, so an old or orphaned Apply
cannot authorize the newly adopted configuration; only a later final Apply can
save the exact current digest.

For the hosted Accounts profile, provider runtime-binding is read-only derivation
with no registration authority; the direct DB-owned module-variable materializer
owns final-Apply activation. Plan and `apply_check` remain read-only and only
final Apply registers or repairs the exact current activation digest. The
`updatedAt` field is ordinary audit time, not activation authority. Schema
promotion is substrate-specific: for PostgreSQL, apply migration 043, then
migration 044, before promoting the feature Worker. For Cloudflare D1, first
verify the exact-v3 ledger/schema closure, then deploy the v3/v4 feature bridge,
which accepts only exact legacy v3 or exact checksummed v4 and performs no
request-time DDL. Retain owner-private backup and status evidence, complete the
bounded pre-ledger backfill, perform the atomic v4 apply and read-only verify,
and wait through the observation window before deploying the exact-v4-only
Worker. A v3-only Worker must never remain live after v4 commits; the bridge is
the compatible rollback floor. Both lanes are additive and forward-only.

If the patch contains an `installing_principal` Interface binding proposal,
target a shared config before Capsule creation so the authenticated create flow
can resolve the installer into an exact Principal. Takosumi rejects that
placeholder on a Workspace-scoped per-install config; it never guesses the
original installer during a later release update.

## Failure and rollback

Unknown kinds/fields and invalid declarations fail before storage. Keep the
previous reviewed InstallConfig projection in operator evidence. Rollback is a
second explicit patch file containing the previous mutable values, followed by
a fresh reviewed Plan. Do not retry a failed lifecycle action by replaying an
already consumed Plan.
