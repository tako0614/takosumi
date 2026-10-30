# Capsule scopeRef: frozen derivation scope and backfill

TASK-0118 Phase 9 removes Workspace. A Capsule's Workspace id is also an input
to values that must never move: generated secrets, sealing AADs, nonces, the
public OIDC client id, resource names and storage keys. Stage 9.0 gives every
Capsule an immutable, opaque `scopeRef` and makes those derivations read it
instead of the Workspace id. This page records what reads it, what does not
yet, and how operators backfill existing rows. It is a code change and a local
fixture verification; it does not authorize a staging or production operation.

## The value

- `Capsule.scopeRef` lives in the Capsule record JSON (`capsules.record_json`
  on D1, `takosumi_capsules.installation_json` on Postgres). No DDL.
- It is written once, at creation (`CapsulesService.createCapsuleInitialAuthority`),
  and is the new Capsule's Workspace id in stage 9.0. Stage 9.1 may switch new
  Capsules to their own id; existing values never change.
- `capsuleScopeRef(capsule)` returns it, falling back to `workspaceId` for a
  row written before stage 9.0. The fallback is exactly the value the backfill
  stores, so a derived value is identical before and after the backfill.
- It grants nothing. No membership, listing or authorization decision reads
  it, and it is stripped from every public Capsule projection.
- Exact-record replays of initial creation treat a pre-9.0 row and its
  scopeRef spelling as the same Capsule (`capsuleWithScopeRef`), so an install
  retried across the deploy replays instead of conflicting. (A rollback to
  pre-9.0 code would see the reverse: an install first written by 9.0 code and
  retried by old code conflicts. Keep the rollback window short.)

## What reads scopeRef (stage 9.0)

| Derived value | Where | Golden test |
| --- | --- | --- |
| Generated-secret HMAC (v1 and v2), run-scoped lane | `core/domains/deploy-control/runtime_input_materializer.ts` `generatedSecretDerivationParts` | values for v1/v2 |
| Same derivation, private runtime-binding lane | `deploy/platform/runtime_binding_materializer.ts` | values for v1/v2 |
| Runtime-input nonce and derived generation | `runtime_input_materializer.ts` `runtimeInputNonce`, `derivedGeneration` | nonce for v1/v2 |
| Sealed runtime-input AAD and the previous-generation AAD check | `runtime_input_materializer.ts` `runtimeInputAad`, `previousGenerationAadNamesOwner` | AAD string |
| Runtime secret file AAD | `core/domains/deploy-control/runtime_secret_file_materializer.ts` | AAD string |
| Destroy runtime-input nonce | `core/domains/deploy-control/run-engine/run_engine.ts` `destroyRuntimeInputNonce` | nonce |
| Public OIDC client id (runtime-binding and run-scoped lanes) | `runtimeOidcClientDerivationParts`, `runtime_input_oidc_client_source.ts` | `OIDC_CLIENT_ID` |
| Repository OIDC client id | `deploy/platform/accounts_oidc_module_variable_materializer.ts` | client id variable |
| OIDC activation digest scope slot (registration and live grant) | `accounts/service/src/oidc-activation.ts`, `oidc-live-grant.ts` and the three registrars | activation digest |
| Public-origin reservation key and requested label | `deploy/platform/platform_extension_provider_credentials.ts` | key and label |
| Install-context `workspace_id` module variable (apps build storage paths, cookie contexts and MCP keys from it) | `run_engine.ts` | merged variables |
| `workspace_scoped_capsule_name` suffix on re-adoption | `accounts/service/src/control/install-config-re-adoptions.ts` | suffix |
| Re-adoption and configuration-plan successor InstallConfig ids (the identity an idempotent retry finds) | `install-config-re-adoptions.ts` `reAdoptionTargetInstallConfigId`, `configuration-plans.ts` `configurationTargetInstallConfigId` | successor ids |
| `TAKOSUMI_WORKSPACE_ID` and `TAKOSUMI_RELEASE_CONTEXT_JSON.workspaceId` of release commands, runner and operator alike | `worker/src/release_activator.ts`: the runner job, and the operator webhook payload's `workspaceId` that `scripts/operator-release-activator.ts` copies into both variables | release environment |
| Legacy artifact root of a Capsule row without a persisted `storage_root` | `getCapsuleStorageRoot` in the memory, Postgres and D1 stores; `worker/src/stored-capsule-root.ts` | root and state/raw-output refs |
| Legacy `storage_root` the ownership backfill writes | `core/domains/app-ownership/backfill.ts` | backfill plan |

The historical JSON key `workspaceId` stays inside every AAD, nonce and digest
preimage; only its value source changed. Authority checks and owner fences
(the secret blob's Workspace column, `capsule.workspaceId === request.workspaceId`)
still read the Workspace id.

`tests/deploy/platform/capsule_scope_ref_golden_test.ts` pins each value as
produced by the unmodified code (`origin/main` `2545cfefa`, and `fcd54776f` for
the rows added by the follow-up) and derives it again for three Capsules: a
pre-9.0 row without scopeRef, a backfilled row, and a row whose authority
Workspace id has moved while scopeRef stays frozen. All three produce
byte-identical values, which also proves the derivations follow scopeRef rather
than the Workspace id.

Leaf tests alone would still pass if a caller went back to the Workspace id, so
the callers are driven too, each with a Capsule whose scopeRef differs from its
live Workspace id:

- `tests/core/domains/deploy-control/capsule_scope_ref_run_engine_test.ts`:
  RunEngine Plan (install-context `workspace_id`, sealed AAD) and destroy Plan
  (the baked destroy nonce). The plan context type requires the scopeRef
  whenever it carries run-scoped input authority, so the destroy nonce has no
  Workspace fallback.
- `tests/accounts/service/src/capsule_scope_ref_re_adoption_test.ts`: the
  re-adoption route (successor id, `workspace_scoped_capsule_name`) and the
  configuration-plan route (successor id).
- The golden test's caller block: the runner release activator, the store's
  storage root plus allocation, and the public-origin reservation through the
  port and its release through runtime-input retirement.

## Artifact root

The persisted `storage_root` is the authority for a Capsule's artifact keys:
`apps/{cap}` for Capsules created after ownership expansion, or the legacy
`workspaces/{ws}/capsules/{cap}` the ownership backfill froze. Core allocation
(`capsuleArtifactRoot`, used for Apply/destroy state, raw output, restore and
operator state recovery) returns the stored root as is and never rebuilds or
compares its Workspace segment with a live Workspace id; it only checks that
the root ends in this Capsule's own segment. A row without a persisted root
(before the v77 column) derives the legacy root from scopeRef, which is the
Workspace id it was written under, and the ownership backfill freezes that
same root. No root segment may be empty or a dot-only path step. The local
runner's recovery custody check accepts exactly the canonical generation-1
ref of the persisted root its stateRef names, instead of rebuilding the legacy
ref from the artifact's Workspace id. Objects never move.

## What does not read scopeRef yet

These still read the Workspace id. Their values are identical today because
every Capsule's scopeRef equals its Workspace id; each must move to scopeRef
(or stop depending on Workspace) before the Workspace id can change.

| Value | Why it is not switched in 9.0 | Owner stage |
| --- | --- | --- |
| OIDC activation digest, InstallConfig part | The digest also hashes the whole InstallConfig record, which carries its own `workspaceId`. If a later stage rewrites stored InstallConfig records (for example while dropping the column), every activation digest moves and sign-in fails with `install_grant_stale` until the next Apply re-registers. **This cannot be held constant by scopeRef.** | 9.5/9.6: keep stored InstallConfig JSON unchanged, or re-register activations in the same window |
| Repository OIDC materialization digest | Plan-to-Apply consistency digest that also binds the authority Workspace; not durable | none (recomputed per Plan) |
| Interface and InterfaceBinding ids (`capsuleBlueprintRecordId`) | Derived from the Interface's Workspace, which is still its ownership scope | 9.1-g |
| Private run-file scope, R2 keys and AAD | Keyed by the `workspace_id` column (part of the primary key); production has 0 rows | 9.5/9.6 |
| Source archive and backup object keys of an existing Capsule | Since 9.1-f a new app's archives and backups go under `apps/{cap}` ([app storage roots](./app-storage-roots.md)). An existing Capsule's backups follow the Workspace segment of its frozen root; its Source's archives keep `workspaces/{ws}/sources/…` from the Source record's own Workspace id (a Source has no scopeRef); objects already written stay where they are | 9.5/9.6 (keep `sources` record JSON, or freeze a Source scope, before dropping the column) |
| Runner Durable Object state prefix, `current.json` pointer and object metadata | 9.1-f: the DO reads an `apps/` root back from the stateRef, new objects carry `takosumi-capsule-id` and `takosumi-storage-root`, and Restore accepts the old `takosumi-workspace-id` binding only for objects without a root ([app storage roots](./app-storage-roots.md)). A legacy root must still match the dispatch's Workspace id | 9.5 (dispatch carries the frozen scope) |
| Stored-object owner resolution and storage usage (`worker/src/stored-object-owner-resolver.ts`, `worker/src/artifact-storage-usage.ts`) | 9.1-f: an `apps/` object belongs to its Capsule and reports the Capsule's scopeRef as `workspaceId` for the host contract; a legacy object keeps its Workspace attribution, and a pointer is matched against the retained StateVersion's own root | 9B (Hosted keys `apps/` facts by Capsule), 9.5/9.6 for legacy objects |
| Restore fence Durable Object name (`worker/src/container_runner.ts` `restoreRunnerObjectName`) | Built from the restore job's state-scope Workspace id; the serialized restore job carries no scopeRef. Matters only to a restore in flight while the Workspace id changes | 9.1-f/9.5 (add the scope to the job contract) |
| Staged state-recovery handle and custody digest (`worker/src/state_recovery_artifact_store.ts`) | The handle encodes the Workspace id and is parsed back into the recovery scope that is checked against the Capsule, so it is authority, not only a key. Handles are short-lived | 9.5 |
| Public-origin host context `workspaceId` (reserve and release) and `x-takosumi-platform-workspace-id` | Hosted derives the reservation id and the wallet `tenantRef = HMAC(workspaceId)` from it. Sending scopeRef would give a 9.1 Capsule (scopeRef = its own id) a per-app tenant, so it moves with the account billing context; the reservation key and label already read scopeRef | 9B (Hosted moves to `legacy_tenant_ref`) |
| `tkrn:${workspaceId}:…` managed resource ids | Produced by the host; Takosumi only validates the prefix | 9.7 |
| Install-time compile of `workspace_scoped_capsule_name` | Runs before the Capsule exists; uses the plan's Workspace id, which becomes the new Capsule's scopeRef in 9.0 | 9.1 (when new Capsules use their own id) |

Stage 9.1 must also make scopeRef write-once at the store level before new
Capsules get a scopeRef that differs from their Workspace id: today every
writer preserves it by spreading the stored record, and a dropped value falls
back to the same Workspace id. Until then the backfill relies on re-runs (see
below).

## Backfill

`scripts/backfill-capsule-scope-ref.ts` writes `scopeRef = workspaceId` into
every Capsule row that has none, destroyed rows included. Each write is one
conditional UPDATE of one row: it applies only while the row still has no
scopeRef and its column and record still name that Workspace, so a concurrent
writer is never overwritten and a re-run is a no-op. Rows with a different
scopeRef are reported (`diverged`) and never changed. Rows the conditional
write could never apply are refused instead of planned: no Workspace id in the
record (`record_workspace_missing`), no `space_id` (`workspace_column_missing`),
or the two disagree (`workspace_column_mismatch`). Resolve each refused row
before expecting the gate query to reach 0.

The operator module owns the connection, as for the ownership backfill:

```ts
// /absolute/operator/scope-ref-target.ts
import { CloudflareD1RestTransport } from "<repo>/deploy/cloudflare/d1-rest-transport.ts";
import { d1CapsuleScopeRefBackfillTarget } from "<repo>/core/domains/capsules/scope_ref_backfill.ts";

export async function openCapsuleScopeRefBackfill() {
  const db = new CloudflareD1RestTransport({ accountId, databaseId, apiToken });
  return { target: d1CapsuleScopeRefBackfillTarget(db) };
}
```

Postgres uses `sqlCapsuleScopeRefBackfillTarget(client)` with any `SqlClient`.
For a rehearsal, point the D1 target at a local SQLite copy of an export
(`SqliteControlD1Database`).

```bash
bun --no-env-file scripts/backfill-capsule-scope-ref.ts --adapter="$ADAPTER" --dry-run
# review: total, byStatus, writes, writeIds, alreadyFrozen, diverged, refused, digest
bun --no-env-file scripts/backfill-capsule-scope-ref.ts --adapter="$ADAPTER" \
  --apply --plan-digest=sha256:<reviewed digest>
```

`--apply` re-plans and refuses if the write set differs from the reviewed
digest, then reports `frozen`, `skipped` (rows frozen or moved by someone else
meanwhile) and `remaining` (expected 0).

Capsule writers replace the whole record from a copy they read earlier. A
writer that read a row before the backfill froze it and writes after drops the
fresh value again. Nothing derived moves (reads fall back to the same
Workspace id), but the row shows up in `remaining` or in the gate query. Run
the dry-run and apply again until both are 0; each pass touches only rows that
still lack the value. Verify with the gate query:

```sql
select count(*) from capsules where json_type(record_json, '$.scopeRef') is null; -- D1, expect 0
select count(*) from takosumi_capsules where installation_json->'scopeRef' is null; -- Postgres, expect 0
```

Production numbers at planning time (2026-10-30): 58 Capsule rows in
production, 103 in staging. Running the backfill against staging or
production is a data change and needs the user's prior approval.

Rollback: the stored value equals the Workspace id, so returning to code that
ignores the field changes nothing. Nothing needs to be deleted.
