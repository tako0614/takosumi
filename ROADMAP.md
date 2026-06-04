# Takosumi GA Roadmap

Takosumi is the OpenTofu-native deploy control plane, UI, and audit ledger.
GA keeps Takosumi small: Installation, Deployment, PlanRun, ApplyRun,
RunnerProfile, DeploymentOutput, policy decisions, state evidence, and audit
events.

## Current Direction

- Repositories are plain OpenTofu modules. Metadata comes from Git/prepared/local
  source identity, module path, variables, and well-known OpenTofu outputs.
- RunnerProfile owns provider allowlists, deny rules, credential references,
  state backend, state lock policy, execution image/resource limits, network
  policy, Cloudflare Container execution settings, optional Cloudflare Workers
  for Platforms tenant dispatch settings, and secret exposure policy.
- Default provider profiles cover Cloudflare, AWS, GCP, Azure, Kubernetes/Helm,
  GitHub, DigitalOcean, and local Docker by OpenTofu provider source address.
- In the Cloudflare reference topology, OpenTofu `plan/apply` runs in the
  Container runner. Workers for Platforms is tenant / user Worker ingress and
  dispatch only; operator provider credentials are not bound into user Workers.
- ApplyRun requires the full reviewed PlanRun guard: PlanRun id, RunnerProfile,
  source digest, variables digest, policy decision digest, plan digest, optional
  source commit, and optional provider lock digest.
- DeploymentOutput is public non-sensitive output only. Sensitive OpenTofu
  outputs are skipped by the public projection.

## Completed

### Contract and Control Plane

- [x] Single package direction for `@takosjp/takosumi`.
- [x] Service implementation renamed away from old public control-plane vocabulary.
- [x] Deploy Control API request/response DTOs frozen for RunnerProfile,
      PlanRun, ApplyRun, Installation, Deployment, DeploymentOutput, errors,
      state evidence, and audit events.
- [x] Apply is guarded by reviewed PlanRun id, source/module identity digest,
      RunnerProfile, variables digest, policy decision digest, plan digest,
      source commit, and provider lock digest.
- [x] Old public DeployControl API wording removed from docs and SDK examples.
- [x] OpenTofu-only repository fixture coverage uses generic Git/local source
      metadata and OpenTofu output.

### Runner Profiles

- [x] GA RunnerProfile schema includes provider allowlists, denied providers,
      credential references, credential-ref enforcement, state backend, state
      lock policy, resource limits, network policy, and Cloudflare Container
      execution settings.
- [x] Cloudflare RunnerProfile schema records Workers for Platforms dispatch
      namespace, outbound Worker policy, tenant Worker binding policy, and
      secret exposure policy without changing the OpenTofu runner substrate.
- [x] Provider deny policy blocks before plan/apply side effects.
- [x] Required credential reference absence blocks before plan/apply side
      effects.
- [x] ApplyRun records state backend and state lock evidence.
- [x] Default Cloudflare/AWS/GCP RunnerProfiles encode Cloudflare Container
      execution settings.
- [x] Default Azure, Kubernetes/Helm, GitHub, DigitalOcean, and local Docker
      RunnerProfiles encode OpenTofu provider allowlists, credential references,
      state backend refs, secret exposure policy, and provider network policy.
- [x] RunnerProfile network policy supports exact hosts and provider API suffix
      patterns for region / service-specific endpoints.

### OpenTofu Proofs

- [x] Parse `tofu output -json` shape into DeploymentOutput material.
- [x] Credential-free OpenTofu output proof records operator-supplied output
      material into Deployment evidence.
- [x] Live local non-production OpenTofu proof executes `tofu init`, `tofu plan`,
      `tofu apply`, and `tofu output -json` through a Takosumi OpenTofu runner.
- [x] Sensitive outputs are skipped by the public DeploymentOutput projection.
- [x] PlanRun / ApplyRun / DeploymentOutput proof records immutable output,
      state-lock, and audit evidence.
- [x] Runner diagnostics and failure audit messages are redacted before
      PlanRun / ApplyRun / DestroyRun persistence.

### Deployment Outputs and UI

- [x] Well-known public output names are defined:
      `launch_url`, `admin_url`, `health_url`, `docs_url`, `service_url`, plus
      `takosumi_`-prefixed variants.
- [x] DeploymentOutput read API added:
      `GET /v1/installations/{installationId}/deployment-outputs`.
- [x] Dashboard Installation detail projects non-sensitive DeploymentOutput
      values without exposing secret literals.

### Audit and Managed Readiness

- [x] PlanRun stores audit events for plan requested, policy evaluated, plan
      started, plan completed, and plan failed.
- [x] ApplyRun stores audit events for apply queued, started, completed, and
      failed.
- [x] DestroyRun stores audit events for destroy queued, started, completed, and
      failed.
- [x] Deployment stores output snapshot recorded audit events.
- [x] Exportable proof scripts include output digest, ApplyRun output digest,
      Deployment output digest, state lock status, and audit event count.

### Documentation and Publication Readiness

- [x] Takosumi v1 docs aligned to OpenTofu-native Deploy Control API.
- [x] CLI docs aligned to current `plan`, `install`, `deploy`, and `rollback`
      commands.
- [x] RunnerProfile / DeploymentOutput docs aligned to public non-sensitive
      output projection.
- [x] Takosumi public docs build.
- [x] npm publication rehearsal for `@takosjp/takosumi`.

## Verification Commands

- [x] `bun run check`
- [x] `bun test ... deploy-control / API / CLI / proof targeted tests`
- [x] `bun run opentofu:deployment-output-proof`
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
- [ ] Capture managed offering launch evidence with operator Cloudflare
      credentials, DNS, account-plane, billing, OIDC, and dashboard enabled.
- [ ] Capture hosted Cloudflare Container runner evidence for a real
      non-production provider apply.
- [ ] Capture AWS, GCP, Azure, Kubernetes/Helm, GitHub, and DigitalOcean
      non-production provider `plan/apply/destroy` evidence for every profile
      enabled by the operator.
- [ ] Capture Workers for Platforms dispatch namespace and outbound Worker
      isolation evidence for tenant / user Worker execution.
- [ ] Capture secret-boundary leak tests proving provider credentials, Deploy
      Control tokens, and state backend credentials are not visible to tenant
      Workers, diagnostics, audit payloads, or DeploymentOutput records.

## Non-Goals

- Adding a Takosumi-specific source metadata file.
- Reintroducing the pre-v1 source metadata and dry-run API model as public v1
  doctrine.
- Storing raw provider credentials or secret output literals in Takosumi public
  ledger records.
- Adding another runtime requirement during the Bun migration.
