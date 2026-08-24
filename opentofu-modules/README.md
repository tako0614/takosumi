# OpenTofu example modules

This directory contains ordinary OpenTofu/Terraform modules maintained with
Takosumi. It is not a built-in install catalog and none of these modules is
copied into the runner as execution authority.

Takosumi installs a Capsule from an explicit Git URL, ref/commit, and module
path. The selected immutable `SourceSnapshot` is the only module source used by
plan/apply/destroy. A module in this repository therefore behaves exactly like
a module in any other Git repository.

## Layout

- `opentofu-modules/core/module` is a small provider-free example.
- Provider-specific examples live with their optional provider helper, such as
  `providers/cloudflare/modules/cloudflare-hello-worker/module` and
  `providers/cloudflare/modules/cloudflare-static-site/module`.

These examples do not create an allowlist. An operator may install different
modules and providers without changing Takosumi Core.

Current Takosumi has no Resource Shape module registry, TargetPool selection,
or configuration binding for either concept. Retained rows from the retired
embedded Host schema are not runnable modules: before PostgreSQL v110 or D1 v66,
an affected operator must inventory and export them on the immediate predecessor
or with out-of-band database tooling, record an explicit disposition, and then
retry the empty-only forward migration.

## Adding an example

1. Add a plain child module under the domain or provider that owns the example.
2. Keep credentials out of variables and files; use normal provider
   authentication through a Provider Connection and Credential Recipe.
3. Exercise it through an explicit Git Source and module path.
4. Do not add a template registry entry, bundled TypeScript HCL copy, reserved
   Output schema, or runner-image path.
