# Service Form compatibility state inventory

Resource Shape API/provider/state aliases cannot be removed from evidence that
only inspects this repository. Before deciding a support window, an operator
must inventory every OpenTofu/Terraform state and dependency lock file that it
is authorized to inspect.

Run the inventory offline, in the environment that owns the state:

```bash
bun run service-form:compat-inventory -- \
  --state /operator/path/terraform.tfstate \
  --lock /operator/path/.terraform.lock.hcl \
  --output /operator/evidence/service-form-compatibility-inventory.json
```

`--state` and `--lock` are repeatable. The output file is created with
no-overwrite semantics. The report contains only:

- a SHA-256 digest and input class for each inspected file;
- Takosumi/Takoform provider addresses, versions, constraints, and lock hashes;
- compatibility-relevant resource type, provider address, managed/data mode,
  class, and instance count; and
- counts of unrelated resources/providers without their names.

The report never copies Resource attributes, IDs, names, provider configuration,
state lineage/serial, secret values, local input paths, or unrelated provider
identities. Keep the original state and the report in operator-controlled
evidence storage; neither belongs in this repository.

An empty legacy-state result is not permission to remove an alias. A removal
decision still requires the full evidence closure below. The report therefore
always emits `removalDecision.eligible: false`; it is one evidence input, not
release authority.

## Published support policy

[`service-form-removal-policy.json`](../../provider/release/compatibility/service-form-removal-policy.json)
announces the minimum policy without backdating its start:

- the current `takosumi.dev/v1alpha1`, `/v1/resources`, `ResourceShape`, and
  discontinued provider's `takosumi_*` form state aliases stay supported
  throughout Takosumi v1;
- removal can be considered only in v2 or later;
- the support window is at least 365 days and starts at the later of public
  migration notice and stable migration-path availability; and
- the final decision also needs a current zero-legacy-usage observation of at
  least 90 days, ending no more than seven days before evaluation.

The policy has no start timestamp yet. Merging the policy, shipping GA, or
publishing a prerelease does not start or retroactively shorten the window. The
operator records the real public-notice and stable-migration timestamps in the
external evidence closure when both events have happened.

Run the repository-only contract check at any time:

```bash
bun run service-form:compat-removal:check
```

It validates the policy plus the exact Takoform migration fixture authority and
returns success only for that repository contract. Its output always says
`removalEligible: false` and lists the external evidence still required.

## No-op and rollback fixture authority

[`service-form-migration-fixture-authority.json`](../../provider/release/compatibility/service-form-migration-fixture-authority.json)
pins the independent Takoform `v0.1.0-rc.3` source commit and the SHA-256 of its
six-kind legacy mapping, redacted legacy state, ten-kind golden state,
migration evidence, and operator migration guide. Takosumi does not copy or
take ownership of those portable-provider fixtures.

The pinned lifecycle has five ordered phases:

1. digest-bound state backup;
2. old-provider refresh no-op;
3. reviewed remove/import transition over the same canonical Resources;
4. new-provider refresh no-op; and
5. restore of the old state/lock/HCL/artifact set followed by an old-provider
   rollback no-op.

The structural Takoform fixture intentionally labels the three host-dependent
phases `external-required`. The existing
`bun run provider:custody:state-proof` separately validates the retained
historical-custody Takosumi provider's old-state no-op/observe/rollback
behavior. Neither local
fixture substitutes for the live cross-provider operation.

## Removal eligibility gate

After the support and observation windows have actually elapsed, run the
fail-closed gate in the operator evidence environment:

```bash
bun run service-form:compat-removal:eligible -- \
  --evidence /operator/evidence/removal-evidence.json \
  --inventory /operator/evidence/compat-inventory-1.json \
  --takosumi-provider-proof /operator/evidence/1.1.4-state-proof.json \
  --takoform-migration-evidence /operator/evidence/takoform-migration-evidence.json \
  --rollback-artifacts /operator/evidence/rollback-artifacts.json
```

The removal-evidence closure has this exact value-free shape (replace the
example refs, timestamps, counts, and digests with operator evidence):

```json
{
  "schemaVersion": 1,
  "kind": "takosumi.service-form-compatibility-removal-evidence@v1",
  "policySha256": "sha256:<64 lowercase hex>",
  "evaluatedAt": "2028-01-01T00:00:00.000Z",
  "removalCandidateVersion": "2.0.0",
  "supportWindow": {
    "publicNoticeAt": "2026-12-01T00:00:00.000Z",
    "migrationAvailableAt": "2027-01-01T00:00:00.000Z",
    "startedAt": "2027-01-01T00:00:00.000Z",
    "endsAt": "2028-01-01T00:00:00.000Z"
  },
  "inventoryCoverage": {
    "authorizationScopeRef": "vault://takosumi/migration/authorized-scope",
    "authorizationScopeSha256": "sha256:<64 lowercase hex>",
    "complete": true,
    "authorizedTerraformStateCount": "1",
    "authorizedDependencyLockCount": "1",
    "inventorySha256s": ["sha256:<64 lowercase hex>"]
  },
  "usageObservation": {
    "evidenceRef": "evidence://takosumi/migration/usage-window",
    "evidenceSha256": "sha256:<64 lowercase hex>",
    "sourceKind": "operator-route-and-provider-telemetry",
    "startedAt": "2027-10-03T00:00:00.000Z",
    "endedAt": "2028-01-01T00:00:00.000Z",
    "legacyControlRequestCount": "0",
    "legacyStateInstanceCount": "0"
  },
  "takosumiProviderProofSha256": "sha256:<64 lowercase hex>",
  "takoformMigrationEvidenceSha256": "sha256:<64 lowercase hex>",
  "rollbackArtifactManifestSha256": "sha256:<64 lowercase hex>"
}
```

The rollback artifact manifest contains only an opaque evidence-set reference,
digests, and boolean phase results:

```json
{
  "schemaVersion": 1,
  "kind": "takosumi.service-form-compatibility-rollback-artifacts@v1",
  "fixtureOnly": false,
  "artifactSetRef": "vault://takosumi/migration/rollback-set",
  "migrationEvidenceSha256": "sha256:<64 lowercase hex>",
  "artifacts": {
    "stateBackup": "sha256:<64 lowercase hex>",
    "oldDependencyLock": "sha256:<64 lowercase hex>",
    "oldHclRevision": "sha256:<64 lowercase hex>",
    "oldProviderBundle": "sha256:<64 lowercase hex>",
    "newProviderBundle": "sha256:<64 lowercase hex>",
    "restoreDrillTranscript": "sha256:<64 lowercase hex>"
  },
  "phases": {
    "oldRefreshNoOp": true,
    "newRefreshNoOp": true,
    "rollbackRefreshNoOp": true,
    "interruptionRestoreDrill": true
  },
  "stateValuesEmbedded": false,
  "credentialValuesEmbedded": false
}
```

`--inventory` is repeatable. The removal evidence binds every input by SHA-256,
declares the authorized state/lock scope and exact covered counts, and carries
only `evidence://` or `vault://` references. The rollback manifest embeds no
state or credential value; it records digests for the state backup, old lock,
old HCL revision, old/new provider bundles, and restore-drill transcript.

The gate rejects a v1 removal, a support-window start before either public
notice or stable migration availability, a short/active window, stale or
non-zero usage, incomplete authorized inventory, any live legacy form instance,
an external-required migration phase, stale historical-custody Takosumi
provider proof, a missing
rollback digest, or a failed restore/no-op phase. Passing the gate proves only
technical removal eligibility for the supplied operator scope. It does not
authorize a release, delete retained provider/package bytes, or replace the
release go/no-go decision.
