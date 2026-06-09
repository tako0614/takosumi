# First-party Capsule modules

These are Takosumi's first-party OpenTofu Capsule modules. A user repo may be
the module source itself, or it may be a **build input** for an app-source
InstallConfig; in both cases Takosumi plans/applies a Takosumi-generated root
module that calls a child module.

## Why TypeScript catalog data (not YAML)

The deploy-control service runs in Cloudflare Workers and **cannot read the
filesystem**, so the catalog is authored as TypeScript data:

- `<id>/template.ts` exports a typed `TemplateDefinition`
  (from `@takosumi/internal/deploy-control-api`).
- `<id>/module/` is the human-readable OpenTofu module (the
  `*.tf` + README). It is baked into the runner image at
  `source.localModulePath` (e.g. `/app/templates/<id>/module`).

There is intentionally **no `template.yaml`**: a parallel YAML source would
require a ts/yaml parity test to stay honest, which buys nothing over a single
typed TS object. The `TemplateDefinition` type *is* the schema; `tsc` validates
it, and the templates domain (`src/service/domains/templates/`) adds runtime
invariants (id/version uniqueness, input/output well-formedness).

The `template.ts` object and `module/main.tf` must be kept in sync by hand:
the TS object declares the inputs/outputs/policy the rootgen and plan-JSON
policy enforce; `main.tf` is the actual module those inputs flow into.

## Modules

| id | build | providers | outputs.public |
| --- | --- | --- | --- |
| `core` | — | (none) | `base_domain`, `public_origin`, `member_issuer`, `service_registry_url` |
| `cloudflare-r2-storage` | — | `cloudflare/cloudflare` | `bucket_name`, `location` |
| `cloudflare-worker-service` | bun (`dist/index.js`) | `cloudflare/cloudflare` | `worker_name`, `url` |
| `cloudflare-static-site` | — | `cloudflare/cloudflare` | `project_name`, `url` |
| `aws-s3-storage` | — | `hashicorp/aws` | `bucket_name`, `bucket_arn`, `region` |

## Adding a first-party Capsule module

1. Add `<id>/module/*.tf` (+ README) as a plain OpenTofu child module that
   reads its inputs as `variable` blocks and delegates provider configuration to
   the generated root.
2. Add `<id>/template.ts` exporting a `TemplateDefinition`. Set
   `source.localModulePath` to the in-image path the runner bakes.
3. Register it in `src/service/domains/templates/registry.ts`.
4. Add golden rootgen + policy fixtures.
