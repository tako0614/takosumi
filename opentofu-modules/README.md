# Official template catalog

Takosumi's official templates are the supported OpenTofu surface for installs.
A user repo is a **build input only**; the official template module (baked into
the runner image) is what `tofu` actually plans/applies, wired by a
Takosumi-generated root module.

## Why TypeScript catalog data (not YAML)

The deploy-control service runs in Cloudflare Workers and **cannot read the
filesystem**, so the catalog is authored as TypeScript data:

- `templates/<id>/template.ts` exports a typed `TemplateDefinition`
  (from `takosumi-contract/deploy-control-api`).
- `templates/<id>/module/` is the human-readable OpenTofu module (the
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

## Catalog

| id | build | providers | outputs.public |
| --- | --- | --- | --- |
| `core` | — | (none) | `base_domain`, `public_origin`, `member_issuer`, `service_registry_url` |
| `cloudflare-r2-storage` | — | `cloudflare/cloudflare` | `bucket_name`, `location` |
| `cloudflare-worker-service` | bun (`dist/index.js`) | `cloudflare/cloudflare` | `worker_name`, `url` |
| `cloudflare-static-site` | — | `cloudflare/cloudflare` | `project_name`, `url` |
| `aws-s3-storage` | — | `hashicorp/aws` | `bucket_name`, `bucket_arn`, `region` |

## Adding a template

1. Add `templates/<id>/module/*.tf` (+ README) as a plain OpenTofu module that
   reads its inputs as `variable` blocks and authenticates via provider env.
2. Add `templates/<id>/template.ts` exporting a `TemplateDefinition`. Set
   `source.localModulePath` to the in-image path the runner bakes.
3. Register it in `src/service/domains/templates/registry.ts`.
4. Add golden rootgen + policy fixtures under the templates/rootgen tests.
