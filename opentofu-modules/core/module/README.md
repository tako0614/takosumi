# Provider-free OpenTofu module example

This plain OpenTofu module is a small value-plumbing example. It takes a single
`base_domain` and exposes ordinary root outputs.

- No providers, no managed resources, and no Takosumi-specific manifest or
  resource driver. It uses only HCL `variable` / `locals` / `output`, so it
  plans against an empty provider set.
- Input: `base_domain` (string, required).
- Outputs: `base_domain`, `public_origin` (`https://<base_domain>`).

It has no built-in identity or runner path. To execute it, register this
repository as an ordinary Git Source and select this directory as the module
path, exactly like any third-party Capsule.
