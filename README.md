# Takosumi External Plugins

This package is the external plugin root for the Takosumi shape model. It is
kept outside `takos/paas` so shape providers and templates can evolve without
adding provider implementations to the core control-plane repository.

The legacy 14-port `KernelPlugin` profile factories (aws / gcp / cloudflare /
kubernetes / selfhosted / hybrids) have been retired. The current model is
shape + provider + template; see `CONVENTIONS.md` for the full RFC.

## Exports

- `@takos/paas-plugins`: aggregate re-export.
- `@takos/paas-plugins/shapes`: portable resource shapes (`object-store`,
  `web-service`, `database-postgres`, `custom-domain`).
- `@takos/paas-plugins/shape-providers`: per-cloud `ProviderPlugin`
  implementations for each shape.
- `@takos/paas-plugins/shape-providers/factories`: production wiring that
  injects real lifecycle clients into each shape provider.
- `@takos/paas-plugins/templates`: opinionated multi-shape bundles
  (`web-app-on-cloudflare`, `selfhosted-single-vm`).
- `@takos/paas-plugins/providers/<cloud>`: low-level HTTP gateway clients and
  service-specific descriptors used by `factories.ts`.
- `@takos/paas-plugins/runtime-agent`: handoff/loop adapters used by the
  runtime-agent integration.

The package imports Takosumi contracts (`Shape`, `ProviderPlugin`, `Template`)
from `../takos/paas/packages/paas-contract/mod.ts`.

## How it fits together

1. A `Shape<TSpec, TOutputs, TCapability>` declares a portable resource contract
   (e.g. `object-store@v1`).
2. A `ProviderPlugin<TSpec, TOutputs>` materializes one shape on one
   cloud/runtime (e.g. `aws-s3`, `cloudflare-r2`, `filesystem`).
3. A `Template` bundles several shape instances into a single opinionated
   manifest invocation.
4. `shape-providers/factories.ts` wires production lifecycle clients (HTTP
   gateways, file IO, container runners) into each provider.

See `CONVENTIONS.md` for naming, output schema, capability, and secret reference
conventions, plus the procedure for adding a new provider for an existing shape.

## Live provisioning fixtures

`fixtures/live-provisioning/<provider>.shape-v1.json` contains the live
provisioning fixtures consumed by the shape-model conformance harness.

## Development

Run from this package root:

```sh
deno task check
deno task test
deno task lint
deno task fmt:check
```
