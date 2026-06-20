# cloudflare-worker-service (first-party Capsule module)

Deploys a Hono (or any module-syntax) Cloudflare Worker service from a built
artifact.

## Provider v5 note (verified)

This module targets `cloudflare/cloudflare` v5. The Worker content is uploaded
through the `cloudflare_workers_script` resource:

- `content` carries the **bundled** module JS verbatim (`content = file(...)`).
  In v5, `content` conflicts with `content_file`; `content_file` would require a
  paired `content_sha256`. We use `content = file(var.artifactPath)` so the
  build artifact bytes are uploaded directly.
- `main_module = "index.js"` selects module syntax (the uploaded module that
  exports the `fetch` handler). The build phase must emit a single bundled
  `dist/index.js` whose default export is the fetch handler.
- `script_name`, `account_id`, and `compatibility_date` are the remaining
  required/important arguments.

This module does not create a workers.dev subdomain. In the hosted Gateway path,
namespace scripts are reached through the dispatcher; public ingress must be
projected by dispatcher/custom-route configuration and passed as `publicUrl`.

## Build phase

The template declares a build phase (runtime `bun`):

```
bun install --frozen-lockfile
bun run build      # must produce dist/index.js (a single bundled module)
```

`artifactPath` is `dist/index.js`; the runner copies it to `/work/artifact`,
which this module reads via `file(var.artifactPath)`. The build runs with NO
credentials; only the OpenTofu plan/apply phases receive provider credentials.

## Inputs / outputs

- Inputs: `appName` (string, required), `accountId` (string, required),
  `publicUrl` (string, optional).
- Outputs: `worker_name`, `url`.

`url` returns `publicUrl`, or an empty string when no dispatcher/custom-route
projection is configured.

This directory is baked into the runner image at
`/app/templates/cloudflare-worker-service/module`.
