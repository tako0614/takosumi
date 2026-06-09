# Takosumi GA Roadmap

Takosumi is the source module that provides the OpenTofu-native control plane, the accounts plane, and the audit ledger
consumed in-process by the platform worker and the self-hosted Takos product worker. GA keeps Takosumi small: Space,
Source, Connection, Provider Template, Provider Env Set, ProviderEnvSet, OpenTofu Capsule, Installation,
InstallConfig, DeploymentProfile, ProviderBinding, Dependency, SourceSnapshot, DependencySnapshot, StateSnapshot, Run,
RunGroup, Deployment, OutputSnapshot, Backup, policy decisions, state evidence, billing, and Activity.

## Current Direction

- Takosumi is consumed in-process by the takos worker via `tsconfig` aliases
  (`deploy/accounts-cloudflare/src/handler.ts` + `worker/src/handler.ts`). There is no standalone Takosumi
  worker, no retired split account/deploy-control host, and no npm publish.
- Repositories are plain OpenTofu modules. Metadata comes from Git URL, commit, tag, module path, variables, and
  well-known OpenTofu outputs.
- Connection / ProviderBinding / Provider Template / policy own provider allowlists, deny rules, credential
  references, state backend, state lock policy, execution image/resource limits, network policy, and Cloudflare
  Container execution settings.
- OpenTofu `plan/apply` runs in the Cloudflare Container runner.
- Apply requires the reviewed plan Run guard: plan digest, source snapshot, compatibility report, dependency snapshot,
  state generation, policy decision digest, optional source commit, and optional provider lock digest.
- OutputSnapshot stores allowlisted public/Space outputs only. Sensitive OpenTofu outputs stay in encrypted artifacts
  unless explicitly shared by policy.

## Completed

### Contract and Control Plane

- [x] Deploy-control and account-plane handlers consumed in-process by the takos worker.
- [x] Service implementation renamed away from old public control-plane vocabulary.
- [x] Deploy Control API request/response DTOs aligned to Space, Source,
      Connection, Installation, Dependency, Run, RunGroup, Deployment,
      OutputSnapshot, errors, state evidence, billing, and Activity.
- [x] Apply is guarded by reviewed plan Run id, source/module identity digest,
      resolved execution policy, variables digest, policy decision digest, plan
      digest, source commit, and provider lock digest.
- [x] Old public DeployControl API wording removed from docs and SDK examples.
- [x] OpenTofu-only repository fixture coverage uses generic Git/local source
      metadata and OpenTofu output.

### Execution Profiles

- [x] Internal execution profile schema includes provider allowlists, denied providers,
      credential references, credential-ref enforcement, state backend, state
      lock policy, resource limits, network policy, and Cloudflare Container
      execution settings.
- [x] Provider deny policy blocks before plan/apply side effects.
- [x] Required credential reference absence blocks before plan/apply side
      effects.
- [x] Apply Run records state backend and state lock evidence.
- [x] Default Cloudflare execution profile encodes Cloudflare Container execution
      settings.
- [x] Internal execution profile network policy supports exact hosts and provider API suffix
      patterns for region / service-specific endpoints.

### OpenTofu Proofs

- [x] Parse `tofu output -json` shape into OutputSnapshot material.
- [x] Credential-free OpenTofu output proof records operator-supplied output
      material into Deployment evidence.
- [x] Live local non-production OpenTofu proof executes `tofu init`, `tofu plan`,
      `tofu apply`, and `tofu output -json` through a Takosumi OpenTofu runner.
- [x] Sensitive outputs are skipped by the public OutputSnapshot projection.
- [x] Run / Deployment / OutputSnapshot proof records immutable output,
      state-lock, and audit evidence.
- [x] Runner diagnostics and failure audit messages are redacted before
      Run persistence.

### OutputSnapshot and UI

- [x] Well-known public output names are defined:
      `launch_url`, `admin_url`, `health_url`, `docs_url`, `service_url`, plus
      `takosumi_`-prefixed variants.
- [x] OutputSnapshot projection is exposed through the public Run /
      Deployment / Installation detail surfaces without using the legacy
      `DeploymentOutput` public vocabulary.
- [x] Installation detail (now in the takos product SPA) projects non-sensitive
      output values without exposing secret literals.

### Audit and Readiness

- [x] Run stores audit events for plan requested, policy evaluated, plan
      started, plan completed, and plan failed.
- [x] Run stores audit events for apply queued, started, completed, and
      failed.
- [x] Run stores audit events for destroy queued, started, completed, and
      failed.
- [x] Deployment stores OutputSnapshot recorded audit events.
- [x] Exportable proof scripts include output digest, apply Run output digest,
      OutputSnapshot digest referenced by Deployment, state lock status, and
      audit event count.

### Documentation and Publication Readiness

- [x] Takosumi v1 docs aligned to OpenTofu-native Deploy Control API.
- [x] CLI docs aligned to the current in-repo operator CLI; external install /
      plan / apply / destroy flows use the dashboard and public `/api` Run
      surface.
- [x] Internal execution profile / OutputSnapshot docs aligned to public non-sensitive
      output projection.
- [x] Production hardening evidence validator and live internal gate verifier
      added for the operator-live Cloudflare Container smoke, egress
      enforcement, Provider Template, and secret-boundary proofs.
- [x] Takosumi public docs build.

## Verification Commands

- [x] `bun run check`
- [x] `bun test ... deploy-control / API / CLI / proof targeted tests`
- [x] `bun run opentofu:output-snapshot-proof`
- [x] `bun run opentofu:live-local-proof`
- [x] `bun run test:scripts`
- [x] `bun run lint:json-ld`
- [x] `bun run docs:build`
- [x] `bun run website:deploy`

## Operator-Live Evidence

These are deployment-environment proofs rather than remaining Takosumi source
work:

- [x] Publish Takosumi website/docs to Cloudflare Pages (`bun run website:deploy`):
      <https://eae08889.takosumi-website.pages.dev>
- [ ] Capture hosted Cloudflare Container runner evidence for a real
      non-production provider apply.
- [ ] Capture secret-boundary leak tests proving provider credentials, Deploy
      Control tokens, and state backend credentials are not visible to
      diagnostics, audit payloads, or OutputSnapshot records.

## Non-Goals

- Adding a Takosumi-specific source metadata file.
- Reintroducing the pre-v1 source metadata and dry-run API model as public v1
  doctrine.
- Reintroducing standalone Takosumi workers, dedicated accounts/deploy-control
  subdomain surfaces, or npm publication.
- Storing raw provider credentials or secret output literals in Takosumi public
  ledger records.
- Adding another runtime requirement during the Bun migration.
