# Workspace policy: bake into each app, then stop the Workspace ceiling

TASK-0118 Phase 9 removes Workspace. A Workspace `policy` is still a runtime
ceiling over every app in that Workspace. Before the Workspace read can go,
each app's own InstallConfig policy must already contain that ceiling. This
page describes the runtime rule, the operator tool that bakes the ceiling, and
the gate. It is a code change and a local fixture verification; it does not
authorize a staging or production operation.

## Runtime rule

`effectiveProviderPolicy(workspacePolicy, installConfigPolicy)` in
`core/domains/deploy-control/provider_policy.ts` decides the provider policy a
Capsule plans, binds credentials and checks compatibility under (connections,
run engine, compatibility context). It replaces the plain
`mergePolicyConfigs(workspace.policy, installConfig.policy)` composition:

- If the InstallConfig policy already contains the Workspace ceiling
  (`workspacePolicyBakedInto`), the InstallConfig policy alone decides. The
  decision is the same as before, because the baked policy is at least as
  strict as the old composition for every key.
- Otherwise the Workspace ceiling is still enforced exactly as before. Nothing
  is loosened for an app the tool has not baked, for an app created later in
  that Workspace, or after someone tightens the Workspace policy (the app is
  unbaked again and the stricter ceiling applies).

The install sheet's connection pre-filter
(`accounts/service/src/control/install-attempt-facts.ts`) still intersects with
the Workspace policy; a new install is never baked, so its runtime enforcement
also still applies.

Only the keys the Workspace layer ever enforced are a ceiling
(`WORKSPACE_POLICY_CEILING_KEYS`): the four allowlists, `destructiveChanges`,
`providerLockfile`, `providerInstallation`, `providerCredentials`,
`scopeBoundary` and `quota`. Other Workspace policy keys (`lifecycleActions`,
`repositoryInstallUx`, unknown keys) never reached a runtime decision and are
neither enforced nor baked; the dry-run lists them as `ignoredKeys`.

## Strictest merge

`bakeWorkspacePolicy` follows the TASK-0118 data policy ("bake Workspace.policy
into each app's InstallConfig policy as the strictest composition"). Each
ceiling key takes the value the runtime composition already enforced:
allowlists intersect, `require*` flags are ORed, required and forbidden lists
are unioned, quotas take the minimum, and both scope-boundary rule sets stay
enforceable. Two differences make the result idempotent and never weaker:

- `destructiveChanges` requires confirmation when either layer does. The old
  composition let the InstallConfig layer override a stricter Workspace value;
  the dry-run lists such an app under `tightenedKeys`.
- Duplicate scope-boundary rules are dropped. An app whose combined rules
  would exceed the persisted limit of 64 is refused
  (`scope_boundary_rule_limit`) and stays enforced through the Workspace.

Non-ceiling InstallConfig keys are kept as they are.

## The tool

`scripts/bake-workspace-policies.ts` plans per app and writes nothing by
default:

- For each Workspace with a ceiling, every live (not destroyed) app is either
  `alreadyBaked`, a `write`, or `refused`.
- A write creates an insert-only successor InstallConfig (the current row with
  the baked policy and a value-free `internal.workspacePolicyBake` receipt) and
  moves the app to it with the store's `rebindCapsuleInstallConfig` CAS. The
  current row and its digest, the app's status, state cursor and
  execution-authority epoch, and the Workspace management epoch must still be
  what the dry-run saw; an active Run returns `busy`. The predecessor row is
  never changed, and no Workspace row is edited.
- The epoch advance supersedes a computed, not yet applied Plan of that app.
- `--apply` re-plans and refuses unless the write set has the reviewed digest
  (`--plan-digest`). The successor id is derived from the reviewed write, so a
  retry after a lost acknowledgement finds the same row. Re-running after a
  successful apply plans no writes.

Refusals keep runtime enforcement for that app: `capsule_uninstalled` (the
uninstall grace period; it bakes or is destroyed later),
`install_config_missing`, `scope_boundary_rule_limit`,
`workspace_management_inactive`, `execution_authority_missing`.

### Sign-in pause for apps with an OIDC client

The Accounts OIDC activation digest binds the InstallConfig row and the
execution-authority epoch, like every InstallConfig rebind (configuration plan,
re-adoption). After the bake, sign-in to an app with an Accounts OIDC client
returns `install_grant_stale` until its owner applies a new Plan, which
registers the activation again. The dry-run marks these writes
`oidcReactivationRequired: true`. Schedule the apply with each app's owner (the
operator credential cannot plan or apply another account's app).

### Running it

The operator module owns the connection and returns a Control store; the tool
never discovers credentials and runs no DDL:

```ts
// /absolute/operator/workspace-policy-bake-target.ts
import { CloudflareD1RestTransport } from "<repo>/deploy/cloudflare/d1-rest-transport.ts";
import { CloudflareD1OpenTofuControlStore } from "<repo>/worker/src/d1_opentofu_store.ts";

export async function openWorkspacePolicyBake() {
  const db = new CloudflareD1RestTransport({ accountId, databaseId, apiToken });
  return { store: new CloudflareD1OpenTofuControlStore(db) };
}
```

Postgres uses `new SqlOpenTofuControlStore({ client })`. For a rehearsal,
point the D1 store at a local SQLite copy of an export.

```bash
bun --no-env-file scripts/bake-workspace-policies.ts --adapter="$ADAPTER" --dry-run
# review: workspaces (ignoredKeys), liveCapsules, alreadyBaked, writes
# (tightenedKeys, oidcReactivationRequired), refused, unbaked, digest
bun --no-env-file scripts/bake-workspace-policies.ts --adapter="$ADAPTER" \
  --apply --plan-digest=sha256:<reviewed digest>
```

`--apply` reports `baked`, `skipped` (the CAS did not apply: `busy`,
`conflict`, `not_found`, `management_inactive`) and `remaining` (the fresh
dry-run's `unbaked`). Run the dry-run and apply again for skipped apps.

## Gate

`unbaked` in the dry-run is the gate: every live app in a Workspace with a
ceiling already contains it, so no runtime decision depends on the Workspace
policy. Keep runtime enforcement until it reports 0; stage 9.5 removes the
Workspace read only then. A Workspace policy written later (the Workspace
`PATCH` route is not frozen) makes the count non-zero again.

Production at planning time (2026-10-30): one Workspace has a policy object
(Q-P1). Running the tool against staging or production is a data change and
needs the user's prior approval, and the OIDC sign-in pause above must be
scheduled with the app owners.

Rollback: rebind the app to its predecessor InstallConfig (named in the
successor's `internal.workspacePolicyBake.previousInstallConfigId`) through the
same CAS, or simply leave it: the runtime rule keeps enforcing the Workspace
ceiling for any app that does not contain it.
