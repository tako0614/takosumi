# Changelog

All notable user-visible changes to the Takosumi source/module release live here.
Takosumi handlers are consumed in-process by the operator platform worker. The
self-hosted Takos distribution worker consumes Takosumi contracts and the
external self-hoster/operator control plane; there is no npm-published service
package for the v1 GA line.

## Unreleased

- Bun + PostgreSQL self-host: the next `docker compose up -d` starts the
  `migrations` service, which now applies pending **existing control-plane
  migrations** before Accounts migrations and before Compose starts `accounts`.
  Already-applied migrations are skipped; no new migration is introduced.
  Review pending migrations and back up the database before upgrading. These
  migrations are forward-only: reverting the image does not undo schema/data
  changes; recovery requires a verified backup restore or forward repair.
  Dependency ordering does not stop an already-running `accounts` container;
  stop it before upgrading when pending migrations require service quiescence.
  After updating source, rebuild with `docker compose up --build -d` so the
  migration service uses the updated image.
- The Accounts container receives only declared service settings from Compose.
  Upstream `clientSecretEnv` names must be explicitly mapped in an operator
  Compose override (see `deploy/node-postgres/README.md`). Runtime image copies
  exclude Cloudflare deployment files except the CLI's required D1 transport.

## 1.0.0 — Canonical control-plane model

Breaking: the public control-plane vocabulary is aligned across the contract,
control plane, account plane, dashboard, CLI, runner env, and HTTP routes.

- Core Stack nouns are now `Workspace`, `Project`, `Capsule`, `Source`,
  `ProviderConnection`, `CredentialRecipe`, `ProviderBinding`, `Secret`, `Run`,
  `StateVersion`, `Output`, `Runner`, `AuditEvent`, and `Operator`.
  `Plan`, `Apply`, and `Destroy` are Run types, not separate lifecycle
  entities. The pre-1.0 ledger nouns `Space`, `Installation`, `StateSnapshot`,
  `OutputSnapshot`, `Deployment`, `Provider Catalog`, `own_key`, and
  `takos_provided` are no longer product nouns.
- `Space` → `Workspace`, `Installation` → `Capsule`, `StateSnapshot` →
  `StateVersion`, `OutputSnapshot` → `Output`; a new `Project` layer sits
  between Workspace and Capsule. The `Deployment` ledger record is retired: a
  successful apply Run plus its `StateVersion` and `Output` is the record.
- HTTP routes move `/spaces` → `/workspaces` and `/installations` →
  `/capsules`; runner env injects `TAKOSUMI_CAPSULE_ID` and
  `TAKOSUMI_STATE_VERSION_ID`. Production hardening uses versioned
  `PlatformHardeningContribution` definitions and one validator-emitted
  `TAKOSUMI_PLATFORM_HARDENING_EVIDENCE` gate bundle; provider/substrate checks
  are not fixed OSS env slots.
- The provider-credential cluster collapses to three concepts —
  `ProviderConnection`, `CredentialRecipe`, `ProviderBinding`. The Provider
  Catalog ownership axis and the `own_key` / `takos_provided` sentinels are
  removed; a provider binds to an explicit ProviderConnection id when it needs
  injected credentials. Omission does not select an operator connection.
- The retired Runtime Projection (`ServiceExport`, `ServiceBinding`, and
  `ServiceGrant`) does not return. Runtime capabilities are declared as
  non-secret `Interface` documents and authorized through `InterfaceBinding`.
  Ordinary OpenTofu Outputs remain explicit module return values; they are not
  a runtime registry or a credential transport.
- The optional Service Form host resolves exact independently versioned
  `FormRef` values into the same canonical `Resource` / `Run` / state / audit
  ledger. `ResourceShape` and related v1 names remain compatibility aliases.
  Generic `Offering` selection is noncommercial OSS policy; official pricing,
  capacity, billing, SLA, and support bindings remain a Cloud concern.
- Takoform independently owns portable Service Form definitions, packages,
  provider releases, and conformance. Takosumi remains provider-neutral:
  Takoform is one supported client/definition authority, not the Takosumi
  lifecycle or Offering type system.
- Cloudflare remains an ordinary provider-native target through explicit
  ProviderConnection / ProviderBinding configuration. AI Gateway, managed
  resources, and Stripe-enforced billing move to the closed `takosumi-cloud/`
  delta (one-way Cloud → OSS, Seam A additive routes + Seam B composition ports).
  OSS billing is a Workspace/Organization-scoped showback-or-disabled ledger
  with no payment gate.
- Physical DB table renames are non-destructive and reversible (rename-aside DDL
  in both the Postgres and D1 catalogs, with a forward-only retired-Deployment
  value translation of the current state-version pointer).

## Pre-v1 Notes

Earlier pre-release notes were consolidated during the v1 rebaseline. The current
source of truth is the docs under `docs/reference/`, `CONVENTIONS.md`, and
package-level READMEs.
