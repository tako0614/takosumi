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

The historical JSON key `workspaceId` stays inside every AAD, nonce and digest
preimage; only its value source changed. Authority checks and owner fences
(the secret blob's Workspace column, `capsule.workspaceId === request.workspaceId`)
still read the Workspace id.

`tests/deploy/platform/capsule_scope_ref_golden_test.ts` pins each value as
produced by the unmodified code on `origin/main` `2545cfefa` and derives it
again for three Capsules: a pre-9.0 row without scopeRef, a backfilled row, and
a row whose authority Workspace id has moved while scopeRef stays frozen. All
three produce byte-identical values, which also proves the derivations follow
scopeRef rather than the Workspace id.

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
| Artifact storage keys and `takosumi-workspace-id` object metadata | Legacy roots are frozen in `storage_root`; new backups and sources still allocate `workspaces/...` prefixes | 9.1-f |
| `TAKOSUMI_WORKSPACE_ID` release environment | Copied from the Apply Run record, which stores the Workspace id | 9.1 (expose scopeRef under that name until 9.7) |
| `x-takosumi-platform-workspace-id` sent to the host (Hosted derives `tenantRef = HMAC(workspaceId)`) | It is the host's authority context, not only a key; Hosted must move to `legacy_tenant_ref` | 9B |
| `tkrn:${workspaceId}:…` managed resource ids | Produced by the host; Takosumi only validates the prefix | 9.7 |
| Install-time compile of `workspace_scoped_capsule_name` | Runs before the Capsule exists; uses the plan's Workspace id, which becomes the new Capsule's scopeRef in 9.0 | 9.1 (when new Capsules use their own id) |

Stage 9.1 must also make scopeRef write-once at the store level before new
Capsules get a scopeRef that differs from their Workspace id: today every
writer preserves it by spreading the stored record, and a dropped value falls
back to the same Workspace id.

## Backfill

`scripts/backfill-capsule-scope-ref.ts` writes `scopeRef = workspaceId` into
every Capsule row that has none, destroyed rows included. Each write is one
conditional UPDATE of one row: it applies only while the row still has no
scopeRef and its column and record still name that Workspace, so a concurrent
writer is never overwritten and a re-run is a no-op. Rows with a different
scopeRef are reported (`diverged`) and never changed; rows whose `space_id`
and record disagree are refused.

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
digest, then reports `frozen`, `skipped` (rows frozen by someone else meanwhile)
and `remaining` (expected 0). Verify with the gate query:

```sql
select count(*) from capsules where json_type(record_json, '$.scopeRef') is null; -- D1, expect 0
select count(*) from takosumi_capsules where installation_json->'scopeRef' is null; -- Postgres, expect 0
```

Production numbers at planning time (2026-10-30): 58 Capsule rows in
production, 103 in staging. Running the backfill against staging or
production is a data change and needs the user's prior approval.

Rollback: the stored value equals the Workspace id, so returning to code that
ignores the field changes nothing. Nothing needs to be deleted.
