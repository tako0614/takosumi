# Service Form Host and Offering Separation

| Field  | Value                    |
| ------ | ------------------------ |
| Status | Accepted                 |
| Date   | 2026-07-28               |
| Scope  | Takosumi v1 architecture |

## Context

Takosumi can run plain Git-hosted OpenTofu stacks and can optionally host
portable Service Forms. Portable definition ownership, canonical resource
lifecycle, generic availability selection, and commercial managed-service
operation are different authorities. Combining them would make a provider,
package registry, compatibility API, or Cloud catalog a second lifecycle
ledger.

This decision is the public, standalone authority for the split used by the
[Final Plan](./final-plan.md). It does not depend on a private ecosystem
checkout.

## Decision

The authorities are separated as follows:

| Authority                                                                                                                                                                                                                          | Owner                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Portable Service Form schemas, exact `FormRef`, data-only Form Packages, typed provider, SDK, fixtures, and portable conformance                                                                                                   | Independent Takoform project |
| Optional zero-form host, canonical `Resource` lifecycle, `Run` / `StateVersion` / `Output` / audit ledger, Form Registry and activation, targets, adapters, credentials, Interface, and generic noncommercial `Offering` selection | Takosumi OSS                 |
| Official implementations, deployment targets, capacity, price catalog, quote, billing, quota, abuse controls, SLA, and support                                                                                                     | Takosumi Cloud               |

The dependency direction is one way: Takosumi may consume exact independently
released portable contracts, and Takosumi Cloud may compose the Takosumi OSS
ports. Takoform does not own Takosumi resources or operations; OSS does not own
portable package releases; Cloud does not redefine either public contract.

## Invariants

- Takosumi Core starts and runs a plain OpenTofu Capsule with zero installed
  Forms.
- `/v1/resources` and its service layer remain the single managed Resource
  lifecycle authority. Provider, CLI, dashboard, and compatibility requests
  translate into that authority rather than creating another ledger.
- Every Form-backed Resource and resolution lock pins an exact immutable
  `FormRef`, package digest, and admitted activation evidence.
- Generic `Offering` resolution accepts open subject types. Takoform is one
  subject adapter, not the Offering type system.
- Commercial offering, capacity, price, billing, and support evidence is an
  additive Cloud binding to an exact generic selection. It is not accepted in
  the OSS generic contract.
- Runtime capabilities use non-secret `Interface` documents and
  `InterfaceBinding` authorization. OpenTofu Outputs remain ordinary module
  return values and never become a credential or runtime registry.
- Credentials and secret values remain in ProviderConnection and
  invocation-time materialization boundaries. Form Packages, Outputs,
  Interfaces, offering catalogs, and public evidence contain no secret values.
- `ResourceShape`, `takosumi.dev/v1alpha1`, and related v1 identifiers are
  compatibility surfaces only. Retention does not create a second authority.

## Release and migration consequences

Takosumi software conformance, Takoform provider/package publication, and
Takosumi Cloud live operation have independent evidence rows. One green row
must not be used to infer another. Exact historical releases remain immutable;
when an independent project supersedes or retires a package generation,
Takosumi keeps custody/readability but requires explicit current admission
before activation.

Compatibility removal is a future, separately reviewed migration. It requires
state inventory, public notice, elapsed support windows, no-op/rollback proof,
and live readback. Takosumi v1 keeps the compatibility surfaces while all
entrances converge on the canonical Resource ledger.
