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

Resource Shape implementations use a separate, explicit operator module
registry. A `TargetPool` implementation descriptor selects an opaque module id
and the host supplies the corresponding files/digest. Resource Shape modules
are not Capsule templates and are never inferred from a provider or shape name.

## Adding an example

1. Add a plain child module under the domain or provider that owns the example.
2. Keep credentials out of variables and files; use normal provider
   authentication through a Provider Connection and Credential Recipe.
3. Exercise it through an explicit Git Source and module path.
4. Do not add a template registry entry, bundled TypeScript HCL copy, reserved
   Output schema, or runner-image path.
