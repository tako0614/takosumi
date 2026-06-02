# Takosumi GA Roadmap

Takosumi is the source-to-deployment substrate and ledger. GA keeps Takosumi
small: Source, Installation, Deployment, PlatformService, InstallPlan, and the
five Installer API endpoints.

## Current Direction

- Takosumi v1 has no `.takosumi` source manifest.
- OpenTofu is the native operator infrastructure manifest and inventory source.
- Operator distributions run OpenTofu, own state and credentials, and publish
  non-sensitive outputs into PlatformService inventory.
- Takosumi reads operator inventory, resolves bindings, records Deployment
  evidence, and exposes the installer/account-plane API surfaces.

## Completed

- [x] Single package direction for `@takosjp/takosumi`.
- [x] Service implementation renamed away from public `kernel` vocabulary.
- [x] Source / Installation / Deployment / PlatformService docs aligned to v1.
- [x] OpenTofu output resolver added under `packages/platform-services`.
- [x] Credential-free OpenTofu binding snapshot proof records
      operator-supplied output inventory into Deployment evidence.
- [x] Current storage schema renamed away from legacy `core_*` table names with
      a compatibility rename migration.

## GA Work

### Contract and Installer

- [x] Freeze Installer API request/response DTOs and error envelope.
- [x] Add OpenTofu-only source fixture coverage: no `.takosumi` file, no
      Takosumi source metadata, only generic repo metadata and OpenTofu output.
- [x] Keep dry-run/apply guarded by `expected.commit` or
      `expected.sourceDigest` plus `expected.planSnapshotDigest`.

### PlatformService Inventory

- [x] Parse `tofu output -json` shape into PlatformService material.
- [x] Add operator example that imports OpenTofu outputs into Space-scoped
      PlatformService inventory.
- [x] Prove sensitive outputs are skipped unless explicitly allowed by the
      operator.
- [x] Prove `tofu output -json` import through PlatformService inventory into
      Deployment `bindingsSnapshot` with matching dry-run/apply digests.

### Operator Distribution

- [x] Prove Accounts/OIDC/billing/dashboard routes on the reference
      `takosumi` operator distribution.
- [ ] Prove one live OpenTofu apply outside Takosumi, then import outputs into
      PlatformService inventory.
- [ ] Record immutable Deployment binding snapshot evidence for the live proof.

### Publication

- [x] `bun run check`
- [x] `bun run test`
- [x] `bun run opentofu:binding-snapshot-proof`
- [x] `bun run build:npm`
- [x] npm publication rehearsal for `@takosjp/takosumi`
- [x] Takosumi public docs build
- [ ] Takosumi public docs deploy

## Non-Goals

- Takosumi-owned OpenTofu state, state locks, provider credentials, or live
  apply orchestration.
- Reintroducing `.takosumi` or another Takosumi-specific source manifest.
- Making optional provider adapters part of the public source contract.
