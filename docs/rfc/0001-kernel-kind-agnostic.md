# RFC 0001: Service Kind-Agnostic Source v1 {#rfc-0001-service-kind-agnostic}

> **Status**: Accepted\
> **Date**: 2026-05-21\
> **Current revision**: 2026-06-01

This RFC records the current Takosumi v1 boundary after the Source v1 reset.
It replaces the earlier source-file driven design with a manifestless source
installation model.

## Summary {#summary}

Takosumi v1 has four public concepts:

- `Source`: git / prepared / local input plus resolved source identity.
- `Installation`: a Space-scoped installed source record.
- `Deployment`: one apply result with source summary, install plan snapshot,
  binding snapshot, outputs, and status.
- `PlatformService`: an operator-catalog service capability selected during
  install or deploy.

Source repositories do not carry Takosumi-specific metadata files. Display and
identity hints come from generic repository metadata such as Git URL, commit,
tag, and package metadata. Binding choices come from the install/deploy request,
account-plane policy, and operator-owned PlatformService inventory.

## Decision {#decision}

Takosumi is a contract executor. It resolves Source identity, produces an
InstallPlan during dry-run, records Deployment evidence during apply, and
validates binding snapshots against operator-supplied PlatformService inventory.

Takosumi does not own infrastructure resource lifecycle, provider state,
backend credentials, billing, OIDC issuer operation, or dashboard policy. Those
belong to operator distributions such as Takosumi, which may use
OpenTofu, OpenTofu, Helm, cloud APIs, HCP Stacks output, static config, or
another workflow to maintain PlatformService inventory.

## Kind Binding Model {#kind-binding-model}

The Takosumi service remains kind-agnostic. Component kinds are implementation
selectors inside the reference apply pipeline, not public Source metadata.
Operator distributions attach implementation bindings through a plain plugin
array, and each binding declares the kind URI it can materialize.

```ts
const { app } = await createTakosumiService({
  plugins: [
    cloudflareWorkerPlugin({ lifecycle: workerLifecycle }),
    cloudflareR2ObjectStorePlugin({ lifecycle: objectStoreLifecycle }),
  ],
});
```

The `https://takosumi.com/kinds/v1/*` URIs are Takosumi official catalog
descriptor URIs. Compatible implementations can bind those descriptors to
native controllers, static registries, workflow engines, SaaS adapters, or
operator-specific code.

## Source Preparation {#source-preparation}

Build and packaging are operator or CI responsibilities. A prepared source is a
content-addressed source view handed to Takosumi through the Installer API.
Takosumi records the resolved source identity and the Deployment evidence
needed to prove what was reviewed and applied.

Dry-run returns an `InstallPlan` plus `planSnapshotDigest`. Apply includes an
expected guard so callers do not review one source or plan and apply a different
one. Takosumi does not expose a caller-supplied idempotency header; internal
idempotency is an implementation detail.

## Platform Service Binding {#platform-service-binding}

Same-installation dependencies and external services are resolved into binding
snapshots during install or deploy. The source does not declare provider
credentials or resource lifecycle operations. Operator distributions publish
PlatformService inventory, and Takosumi records which PlatformService outputs
were selected for a Deployment.

## Non-Goals {#non-goals}

- Add workflow runner, cron, or scheduler ownership to Takosumi.
- Add account, billing, OIDC issuer, dashboard, or onboarding ownership to
  Takosumi.
- Make Takosumi run OpenTofu, OpenTofu, Helm, or cloud provider CLIs.
- Introduce product-specific Takos behavior into the substrate.

## Consequences {#consequences}

- Public docs and current code should use Source / Installation / Deployment /
  PlatformService vocabulary.
- Provider and infrastructure lifecycle wording belongs to operator
  distributions or private operations docs.
- The official catalog can describe portable material contracts without forcing
  one implementation binding.
- Takos remains a product consumer running on Takosumi, not part of the
  Takosumi substrate.
