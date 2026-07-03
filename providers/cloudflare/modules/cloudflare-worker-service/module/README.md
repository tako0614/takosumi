# cloudflare-worker-service (legacy Capsule module)

Legacy first-party example that deploys a Hono (or any module-syntax)
Cloudflare Worker service from a runner-produced JS file. It remains in the tree
for stored pre-v1 row readability and tests, not as an active install option.

The standard Takosumi app-install model is Git OpenTofu execution. New
generated-root dispatch does not run this module's legacy build phase.
Takosumi does not own application build, bundle, container image, or deployable
artifact semantics for generic Capsules; app repos and CI/release pipelines
should do that work and expose ordinary OpenTofu variables when needed.

## Provider v5 note (verified)

This module targets `cloudflare/cloudflare` v5. The Worker content is uploaded
through the `cloudflare_workers_script` resource:

- `content` carries the **bundled** module JS verbatim. Runner-local artifacts
  use `file(var.artifactPath)`. CI/release artifacts use `data "http"` with
  `artifactUrl` and fail closed unless `sha256(content) == artifactSha256`.
  In v5, `content` conflicts with `content_file`; this module keeps the bytes
  explicit inside OpenTofu instead of introducing a separate upload step.
- `main_module = "index.js"` selects module syntax (the uploaded module that
  exports the `fetch` handler). The retired build phase expected a single
  bundled `dist/index.js` whose default export is the fetch handler.
- `script_name`, `account_id`, and `compatibility_date` are the remaining
  required/important arguments.

This module does not create a workers.dev subdomain. In the hosted Gateway path,
namespace scripts are reached through the dispatcher; public ingress must be
projected by dispatcher/custom-route configuration and passed as `publicUrl`.

## Retired legacy build phase

The legacy template object still records the historical build phase (runtime
`bun`) for compatibility metadata:

```
bun install --frozen-lockfile
bun run build      # must produce dist/index.js (a single bundled module)
```

`artifactPath` was historically `dist/index.js`; older dispatch paths copied it
to `/work/artifact`. New Takosumi dispatch no longer runs or threads this build
phase. External `takosumi_edge_worker` provider usage should prefer
`artifactUrl` + `artifactSha256`, which the generated OpenTofu module fetches
and verifies.

## Inputs / outputs

- Inputs: `appName` (string, required), `accountId` (string, required),
  `artifactPath` or `artifactUrl` + `artifactSha256`, `publicUrl` (string,
  optional).
- Outputs: `worker_name`, `url`.

`url` returns `publicUrl`, or an empty string when no dispatcher/custom-route
projection is configured.

This directory is baked into the runner image at
`/app/templates/cloudflare-worker-service/module`.
