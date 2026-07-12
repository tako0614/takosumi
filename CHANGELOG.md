# Changelog

All notable user-visible changes to the Takosumi source/module release live here.
Takosumi is consumed in-process by the operator platform worker and the
self-hosted Takos distribution worker; there is no npm-published service package
for the v1 GA line.

## 1.0.0 — Final 17-noun model

Breaking: the public control-plane vocabulary is renamed to the final 17-noun
model. This is a single coherent surface change across the contract, control
plane, account plane, dashboard, CLI, runner env, and HTTP routes.

- Public nouns are now `Workspace`, `Project`, `Capsule`, `Source`,
  `ProviderConnection`, `CredentialRecipe`, `ProviderBinding`, `Secret`, `Run`,
  `Plan`, `Apply`, `Destroy`, `StateVersion`, `Output`, `Runner`, `AuditEvent`,
  and `Operator`. The pre-1.0 ledger nouns `Space`, `Installation`,
  `StateSnapshot`, `OutputSnapshot`, `Deployment`, `Provider Catalog`,
  `own_key`, and `takos_provided` are no longer product nouns.
- `Space` → `Workspace`, `Installation` → `Capsule`, `StateSnapshot` →
  `StateVersion`, `OutputSnapshot` → `Output`; a new `Project` layer sits
  between Workspace and Capsule. The `Deployment` ledger record is retired: a
  successful apply Run plus its `StateVersion` and `Output` is the record.
- HTTP routes move `/spaces` → `/workspaces` and `/installations` →
  `/capsules`; runner env injects `TAKOSUMI_CAPSULE_ID` and
  `TAKOSUMI_STATE_VERSION_ID`. Production-hardening evidence env is
  `TAKOSUMI_CREDENTIAL_RECIPE_EVIDENCE_REF` / `_DIGEST`.
- The provider-credential cluster collapses to three concepts —
  `ProviderConnection`, `CredentialRecipe`, `ProviderBinding`. The Provider
  Catalog ownership axis and the `own_key` / `takos_provided` sentinels are
  removed; a provider binds to an explicit ProviderConnection id when it needs
  injected credentials. Omission does not select an operator connection.
- The Runtime Projection (ServiceExport / ServiceBinding / ServiceGrant) is removed
  from OSS; runtime service surfaces are projected from a Capsule's
  `tofu output -json` by the consuming product profile.
- The Cloudflare Workers provider compatibility profile, AI Gateway, managed
  resources, and Stripe-enforced billing move to the closed `takosumi-cloud/`
  delta (one-way Cloud → OSS, Seam A additive routes + Seam B composition
  ports). OSS billing is a Workspace/Organization-scoped showback-or-disabled
  ledger with no payment gate.
- Physical DB table renames are non-destructive and reversible (rename-aside DDL
  in both the Postgres and D1 catalogs, with a forward-only retired-Deployment
  value translation of the current state-version pointer).

## Pre-v1 Notes

Earlier pre-release notes were consolidated during the v1 rebaseline. The current
source of truth is the docs under `docs/reference/`, `CONVENTIONS.md`, and
package-level READMEs.
