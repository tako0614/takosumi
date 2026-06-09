# core (first-party base-installation module)

The base Installation under a Space (spec §5/§10). For the MVP this is a pure
value-plumbing module: it takes a single `base_domain` and exposes the canonical
Takos service origins as outputs.

- No providers, no cloud resources. It uses only HCL `variable` / `locals` /
  `output`, so it plans against an empty provider set.
- Inputs: `base_domain` (string, required), `display_name` (string, optional).
- Outputs: `base_domain`, `public_origin` (`https://<base_domain>`),
  `member_issuer` (`https://<base_domain>/auth`), `service_registry_url`
  (`https://<base_domain>/.well-known/takos-services.json`).

This directory is baked into the runner image at `/app/templates/core/module`.
Takosumi generates a root module that wires this module via
`source = "./template-module"` with the typed inputs.
