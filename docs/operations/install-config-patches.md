# InstallConfig patch operation

Last updated: 2026-08-25

Use this operator-only operation only when an app release publishes an
immutable `takosumi.install-config-patch@v1` contribution for an unattached,
Workspace-neutral shared template. It is not an existing-Capsule mutation
surface.

## Apply

1. Download the release asset from the operator-approved release. Verify its
   provenance and digest outside this command.
2. Choose the exact reviewed shared-template InstallConfig id. Do not infer the
   target from the app name, Git URL, tag, or Store listing. The row must have
   no `workspaceId`, no generic/repository/re-adoption provenance, and no
   Capsule reference of any status, including `destroyed`.
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
   before using the template for a new install.

The store re-checks all restrictions and the complete predecessor row in one
CAS. A Workspace-scoped row, a provenance-bearing row, a concurrent change, or
any active/disabled/destroyed Capsule reference returns `409` with reason
`install_config_in_use` without changing the row. The patch does not alter an
already reviewed Plan, download a release, discover a repository manifest,
update a Cloud reference config, or select an app/version automatically.

## Generic Git InstallConfig compilation

The Git install coordinator may derive a Workspace-scoped InstallConfig for an
exact scanner-selected OpenTofu module when no accepted repository install
manifest is available. Before writing that InstallConfig, it runs compatibility
analysis against the exact SourceSnapshot/module and requires both a successful
Run and the complete canonical `rootModuleVariableDeclarations` array. An
explicit empty array means the module declares no root variables; absence is
not equivalent to empty. Failed analysis and missing, malformed, or duplicate
declarations stop before any InstallConfig, Capsule, or Plan write.

The derived row retains only the value-free declaration-contract digest and
SourceSnapshot id. This provenance neither imports values from a redacted
projection nor grants repository-manifest capability. Use the install-plan
coordinator for this derivation; the patch operation must not synthesize or
replace it.

## Existing Capsule configuration Plan

For ordinary settings changes, use the owner-authorized endpoint below instead
of mutating the current row:

```http
POST /api/v1/capsules/{capsuleId}/configuration-plans
Idempotency-Key: <opaque-key>
```

The closed body contains only `variablePatch` (`set`/`remove`), complete
value-free `providerBindings`, `interfaceBlueprints`, and the opaque
`expected.authorityGuard` returned by Capsule GET. The service patches private
values, preserving all omitted values and existing policy/source/module/
runner/lifecycle/output/interface/runtime material, then seals an immutable
successor. The successor, ProviderBindingSet replacement, pending Interface
intent retirement, and execution-authority epoch advance in one CAS before a
review-only Plan is prepared. The endpoint never starts Apply.

The first completed success is `201`. A lost acknowledgement of either the
insert-only successor or the authority CAS is not a replay while no canonical
Plan exists: the retry completes the remaining work and returns `201` with
`replayed:false`. Once the canonical Plan exists, an ordinary identical
same-key replay (including recovery from a lost Plan acknowledgement) returns
`200` with `replayed:true` and the same durable `planRunId`; it does not enqueue
another Plan row. Different input under that key conflicts with `409`.
Redaction sentinels, invalid patches/removals, stale guards,
destroyed/disabled Capsules, and in-flight revision work fail closed. At the
in-flight-work fence, only `queued`/`running` Plan or Apply rows block. A
computed reviewable Plan does not block the transition; the epoch advance
supersedes it. Separate unsafe or ambiguous runtime evidence remains a failure.

Public `PATCH /api/v1/capsule-configs/{id}` and direct
`PUT /api/v1/capsules/{id}/provider-bindings` are retired unconditionally.
After authentication and Workspace authorization they return `405` with
`Allow: GET`, including for unmarked legacy rows. Use Configuration Plan to
change an existing Capsule's complete deployment intent.

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
     "reviewedUserVariables": {
       "public_url": "https://example.test",
       "feature_enabled": true
     },
     "expected": { "authorityGuard": "<guard-from-capsule-get>" }
   }
   ```

   `reviewedUserVariables` is optional for existing clients. When supplied, it
   must be the complete replacement set of non-secret `source.kind=user` inputs
   from the exact pinned repository module. Every required input must be
   present. Omission unsets an optional input, so repeat an unchanged optional
   value to preserve it. Unknown, secret, Capsule/Workspace-derived,
   module-default, host-delivered, or generic-host-policy-colliding values are
   rejected; this is a full review/replacement, not a patch. Recursive
   secret-like keys/values and JSON beyond 32 levels, 4,096 nodes, 256 UTF-8
   bytes per key, or 32,768 UTF-8 bytes per string fail before digest and source
   scanning. Unknown fields, secret-like reasons, malformed guards, and missing
   idempotency keys also fail before mutation. The exact reviewed set is bound
   into the request digest and same-key replay identity.

3. On 200, re-read the Capsule and the returned target InstallConfig. The
   target is a new immutable derived row; the response is value-free and
   identifies the previous and target rows/digests and SourceSnapshot.
4. Create a new ordinary Plan, review it, and apply through the Run API. The
   re-adoption endpoint never runs provider infrastructure and never consumes
   or rewrites an existing Plan.

Normally, re-adoption is allowed only when `runtimeSafety` is `safe` or absent
(there is no decisive candidate). Unsafe or ambiguous Apply/Destroy/Restore
Runs and `queued`/`running` Plan or Apply work return 409. A computed reviewable
Plan is superseded by the epoch transition; a consumed Plan or otherwise
non-decisive terminal history does not block the operation.

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
authority epoch. It requires no `queued`/`running` Plan or Apply. A computed
reviewable Plan is superseded by the epoch transition. Missing or drifted
receipt/Run/StateVersion/Output/config/Capsule/epoch, provider uncertainty or persisted
`providerApplySucceeded=false` partial state, destroy/restore, a newer safety
candidate, or queued/running Plan or Apply returns 409. A successful
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

For an accepted repository-manifest `identity.oidc` request, provider
runtime-binding is read-only derivation with no registration authority;
the Takosumi-owned generic Accounts capability implementation owns final-Apply
activation. The repository `oidc_client` plus paired `public_endpoint`
projections are the only declaration, and exactly four non-secret OIDC values
are delivered. Plan and `apply_check` remain read-only and only final Apply
registers or repairs the exact current activation digest. The `updatedAt` field
is ordinary audit time, not activation authority. Schema
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
target an unattached shared template before Capsule creation so the
authenticated create flow can resolve the installer into an exact Principal.
Takosumi rejects that placeholder on a Workspace-scoped per-install config; it
never guesses the original installer during a later release update.

## Failure and rollback

Unknown kinds/fields and invalid declarations fail before storage. Keep the
previous reviewed shared-template InstallConfig in operator evidence. Rollback
is a second explicit patch file containing the previous mutable values, but is
possible only while the template remains unattached. Once a Capsule references
it, create a new reviewed install/configuration transition instead. Do not
retry a failed lifecycle action by replaying an already consumed Plan.
