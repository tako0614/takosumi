# CLI

The Takosumi CLI is an automation helper for actions you can also do in the
dashboard. The normal product flow is the dashboard `/install?git=...` / `/new`
path: choose a service, choose the provider connection it should use, then
plan / apply. The CLI can target any Takosumi endpoint.

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=https://takosumi.example.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<bearer>

open "$TAKOSUMI_DEPLOY_CONTROL_URL/install?git=https://git.example.com/example/photo-blog.git&ref=v1.0.0&sourcePath=infra&path=deploy/opentofu"

takosumi status <run-id>
takosumi logs   <run-id>
```

When using the Takosumi hosted service, the endpoint is `https://app.takosumi.com`.

The CLI does not run OpenTofu directly. The normal creation flow is dashboard
Git URL install, which creates Source / Capsule / Run records. `sourcePath` is
the Git subtree acquired by the Source; `path` is the scanned module inside that
Snapshot. The Run pins the Git commit / ref and both path coordinates. Execution happens in the runner
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

takosumi launch-readiness validate \
  --file readiness.private.json \
  --contribution-file <owner-controlled-contribution.json>
```

The generated `takosumi.platform-readiness@v2` document embeds the
contribution's `id`, `version`, and `capability` plus its additional
requirement/evidence schema. That embedded copy is not authority. `validate`,
`public-summary`, and `public-summary validate` require the owner-controlled
`--contribution-file` again whenever a document selects contributions. The
validator composes the trusted input and fails closed unless the entire embedded
content matches it exactly, without provider-specific code or an external
registry lookup. A different contribution version is never implicitly
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
completed counts remain exact when Operator or hosted-service contributions are present.

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

## Deployment secrets

The selected runtime adapter and operator vault own deployment-secret storage
and application. The Takosumi CLI does not treat Wrangler, one Worker runtime,
or a fixed secret-name manifest as canonical. Register provider credentials as
Provider Connections through `connections`; generate and store platform-service
signing keys and internal bearers outside the repository, then apply them with
the chosen deployment adapter's native secret command.
