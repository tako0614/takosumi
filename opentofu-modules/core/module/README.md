# core (first-party base Capsule module)

This plain OpenTofu module is a small value-plumbing helper for generated-root
and reference-runner flows. It takes a single `base_domain` and exposes generic
origin values as outputs for Capsules that need a stable public origin or
runtime projection.

- No providers, no managed resources, and no Takosumi-specific manifest or
  resource driver. It uses only HCL `variable` / `locals` / `output`, so it
  plans against an empty provider set.
- Inputs: `base_domain` (string, required), `display_name` (string, optional).
- Outputs: `base_domain`, `public_origin` (`https://<base_domain>`), `member_issuer`
  (`https://<base_domain>/auth`), `service_registry_url`
  (`https://<base_domain>/.well-known/takosumi-services.json`).

This directory is baked into the runner image at `/app/templates/core/module`.
Takosumi generates a root module that wires this module via
`source = "./template-module"` with the typed inputs.
