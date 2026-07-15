# CLI

The Takosumi CLI is an automation helper for actions you can also do in the
dashboard. The normal product flow is the dashboard `/install?git=...` / `/new`
path: choose a service, choose the provider connection it should use, then
plan / apply. The CLI can target any Takosumi endpoint.

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>

open "$TAKOSUMI_DEPLOY_CONTROL_URL/install?git=https://git.example.com/example/photo-blog.git&path=deploy/opentofu&ref=v1.0.0"

takosumi status <run-id>
takosumi logs   <run-id>
```

When using Takosumi Cloud, the hosted endpoint is `https://app.takosumi.com`.

The CLI does not run OpenTofu directly. The normal creation flow is dashboard
Git URL install, which creates Source / Capsule / Run records and pins the Git
commit / ref / path as the Run source identity. Execution happens in the runner
sandbox, and credentials are injected at run time from ProviderConnections and
CredentialRecipes. Source authoring is Git-only; immutable source archives are
internal runner transport and are not accepted as a CLI creation input. The
local-upload path for `takosumi deploy` / `takosumi plan` is retired.

## Platform Readiness Contributions

`takosumi launch-readiness template` generates the baseline shared by OSS and
Operator. When a hosted service or another edition requires additional
operational evidence, the owner maintains a versioned
`PlatformReadinessContribution` JSON and selects it at template-generation time
with `--contribution-file <path>`.

```bash
takosumi launch-readiness template \
  --contribution-file <owner-controlled-contribution.json> \
  > readiness.private.json

takosumi launch-readiness validate --file readiness.private.json
```

The generated `takosumi.platform-readiness@v2` document embeds the
contribution's `id`, `version`, and `capability` plus its additional
requirement/evidence schema. That lets `validate` and the public summary verify
fail-closed from the document alone, without provider-specific code or an
external registry lookup. A different contribution version is never implicitly
treated as the same readiness profile. `validate` never double-interprets a
legacy baseline ID; an explicit `launch-readiness migrate-final-model` updates
it exactly once.

There is no ad hoc collector DSL. When a contribution assists collection
planning, it may only assign its own evidence types to the existing fixed
classes (`browser-user-e2e`, `external-provider`, `operator-review`,
`live-probe-sync`, `operation-drill`, `release-provenance`) through
`collectionClassHints`. Extension evidence that omits a hint remains valid for
validation but is uncategorized for collection planning.
The `takosumi.platform-readiness-report@v2` validation result also returns the
composed definition's `requiredDomainIds` and `requiredRehearsalStepIds`.
Progress consumers use those arrays instead of OSS-only fixed IDs, so totals and
completed counts remain exact when Operator or Cloud contributions are present.

## Connections

Provider credential values are read from files and are never printed.

```bash
takosumi connections create \
  --provider registry.opentofu.org/example/example \
  --recipe generic-env \
  --auth-mode env \
  --secret-partition provider-credentials \
  --values-file <path-to-credential-env-json>

takosumi connections list
takosumi connections test conn_...
takosumi connections revoke conn_...
```

Compatibility APIs are explicit operator-installed extension capabilities. The
Provider Connection CLI never infers a specific gateway or provider family.

## Resource Shape

The Resource Shape flow has no separate sync registry. The CLI operates directly
on the Resource, TargetPool, and SpacePolicy declarations stored by Takosumi and
on explicit reconcile operations. Write requests are read from non-secret JSON
object files. Normal output shows only a Resource phase, Target, Run id, and other
summary fields; it does not print the request body or Output values. Use `--json`
only when the complete public response is required.

```bash
takosumi resources preview --file resource.json
takosumi resources apply EdgeWorker api --file resource.json
takosumi resources import EdgeWorker api --file resource-with-native-id.json

takosumi resources list --space space_...
takosumi resources get EdgeWorker api --space space_...
takosumi resources events EdgeWorker api --space space_...
takosumi resources observe EdgeWorker api --space space_...
takosumi resources refresh EdgeWorker api --space space_...
takosumi resources delete EdgeWorker api --space space_...
```

The `preview` and `apply` files carry the same `kind`, `metadata`, and `spec` as
the Resource Shape API. An `import` file adds a top-level `nativeId`. Credentials
and secrets belong in ProviderConnection / CredentialRecipe, never in a Resource
spec or `nativeId`. `delete --force` succeeds only when the endpoint explicitly
grants operator break-glass authorization.

Target and Policy declarations are sent directly to the same endpoint.

```bash
takosumi target-pools put default --file target-pool.json
takosumi target-pools list --space space_...
takosumi target-pools get default --space space_...
takosumi target-pools delete default --space space_...

takosumi space-policies put default --file space-policy.json
takosumi space-policies list --space space_...
takosumi space-policies get default --space space_...
takosumi space-policies delete default --space space_...
```

`target-pool.json` is an API request body with top-level `space` and
`spec.targets`; `space-policy.json` has top-level `space` and `spec`. A list
`nextCursor` is opaque and must be passed unchanged to the next `--cursor`.

## Deployment secrets

The selected runtime adapter and operator vault own deployment-secret storage
and application. The Takosumi CLI does not treat Wrangler, one Worker runtime,
or a fixed secret-name manifest as canonical. Register provider credentials as
Provider Connections through `connections`; generate and store platform-service
signing keys and internal bearers outside the repository, then apply them with
the chosen deployment adapter's native secret command.
