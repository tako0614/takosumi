# Templates

> Stability: stable Audience: integrator See also:
> [Manifest Expand Semantics](/reference/manifest-expand-semantics),
> [Shape Catalog](/reference/shapes), [Provider Plugins](/reference/providers)

Takosumi kernel receives compiled Shape manifests with concrete `resources[]`.
Template expansion is an installer/compiler concern and must happen before
`POST /v1/deployments`.

## Contract

- The kernel manifest envelope is `apiVersion: "1.0"` + `kind: Manifest` +
  `resources[]`.
- A template may be used by an upstream installer to generate `resources[]`.
- A template result must be fully expanded before the kernel request.
- Provider selection still follows the normal provider resolution rules.

## Immutability

When an installer compiles a template into resources, the resulting resources
are captured by the Deployment. Later template changes do not rewrite existing
Deployments. To update a workload, submit a new compiled manifest.

## Related

- [Manifest Spec](/reference/manifest-spec)
- [Manifest Expand Semantics](/reference/manifest-expand-semantics)
- [Shape Catalog](/reference/shapes)
