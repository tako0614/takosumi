# First-party Capsule modules

These are Takosumi's first-party OpenTofu Capsule modules. A user repo may be
the module source itself, or it may be a **build input** for an app-source
InstallConfig; in both cases Takosumi plans/applies a Takosumi-generated root
module that calls a child module.

## Where modules live

The provider-agnostic `core` base-installation module lives here under
`opentofu-modules/core/`. Provider-specific modules live with their provider
implementation under `providers/<provider>/modules/<id>/`:

- `providers/cloudflare/modules/cloudflare-r2-storage`
- `providers/cloudflare/modules/cloudflare-static-site`
- `providers/cloudflare/modules/cloudflare-worker-service`
- `providers/aws/modules/aws-s3-storage`

The shared bundled-HCL catalog (`module-files.ts`) and the catalog parity test
(`module-files_test.ts`) stay here because they cover `core` plus every provider
module. The id+version registry is `core/domains/templates/registry.ts`.

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
   the generated root. Put it under the owning provider
   (`providers/<provider>/modules/<id>/`), or under `opentofu-modules/` if it is
   provider-agnostic like `core`.
2. Add `<id>/template.ts` exporting a `TemplateDefinition`. Set
   `source.localModulePath` to the in-image path the runner bakes
   (`/app/templates/<id>/module`).
3. Add the bundled HCL to `module-files.ts` and register the template in
   `core/domains/templates/registry.ts`. Add the `<id>` -> on-disk module dir
   mapping in `core/domains/templates/registry_test.ts` and the runner
   `Dockerfile` COPY that bakes it to `/app/templates/<id>/`.
4. Add golden rootgen + policy fixtures.
