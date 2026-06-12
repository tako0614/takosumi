# Quickstart

Run a local Takosumi service, create the control-plane records for an OpenTofu Capsule Installation directly under a Space, and inspect the Compatibility Check / Plan / Apply contract.

The canonical specification is [Core spec](../../core-spec.md). When a local service host has no runner, R2, or billing adapter wired, real OpenTofu execution or credit-based apply blocking may show up as queued, failed, or adapter-unavailable. Current implementation conformance and candidate extensions are tracked in [Core conformance](../../core-conformance.md).

Provider Templates / Provider Env Set are the canonical model. Takosumi-managed providers start Cloudflare-only; AWS /
GCP / GitHub / Kubernetes / arbitrary providers use Space-owned user env set Connections.

## Prerequisites

- Bun
- OpenTofu CLI (`tofu`)
- Git

## 1. Start the service

```bash
cd takosumi
bun install

export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
bun src/cli/main.ts server --port 8788
```

In another terminal:

```bash
export BASE=http://127.0.0.1:8788
export AUTH="Authorization: Bearer dev-token"
```

## Default path: `takosumi deploy ./dir` (upload)

The default way to create an Installation is to **upload a local working directory**. No git Source registration is
required; like `wrangler deploy`, it deploys a local Capsule straight into the Space. Connecting a git Source is the
optional "auto-build on push" add-on, not a precondition for an Installation.

```bash
export TAKOSUMI_DEPLOY_CONTROL_URL=$BASE
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token

takosumi deploy ./my-capsule --space @me --name my-app --var region=apac
takosumi plan   ./my-capsule --space @me --name my-app   # upload + plan only
```

The CLI packs the local directory into a `tar`(zstd) archive, sends it to `POST /api/v1/spaces/:id/uploads` (stored in
R2_SOURCE and recorded as an **upload-origin SourceSnapshot**), then asks `POST /api/v1/deploy` to pin that snapshot,
resolve or create the `@space/name` Installation, and plan it. Because the origin is `upload`, **no Source row is
required and `Installation.sourceId` is absent**; everything downstream (Capsule Gate / plan / apply / DAG) flows
through the same origin-agnostic pipeline. See [CLI](../reference/cli.md) and the Deploy / Upload section of the
[Control Plane API](../reference/deploy-control-api.md) for details.

The steps below (### 2 onward) walk the other path — **git Source integration** — as control-plane records.

## 2. Register a Space and a Source

```bash
curl -s -X POST "$BASE/api/v1/spaces" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"handle":"shota","displayName":"Shota","type":"personal","ownerUserId":"user_dev"}'

curl -s -X POST "$BASE/api/v1/sources" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"spaceId":"<spaceId>","name":"hello","url":"https://git.example.com/example/hello.git","defaultRef":"main","defaultPath":"."}'
```

Replace `url` with a reachable Git repository containing a plain OpenTofu module-compatible configuration.

If the runner substrate is configured, create the SourceSnapshot. A SourceSnapshot pins the Git ref to an immutable commit input.

```bash
curl -s -X POST "$BASE/api/v1/sources/<sourceId>/sync" -H "$AUTH"
# the source_sync Run pins the ref to a commit and records a SourceSnapshot
```

## 3. Inspect provider policy

```bash
curl -s "$BASE/api/v1/providers" -H "$AUTH"
```

Takosumi-managed providers are Cloudflare-only. AWS / GCP / GitHub / Kubernetes / arbitrary providers use Space-owned
user env sets. Provider Template routes and the provider-env-set Connection route are the compatibility UI / CLI entry
points.

## 4. Create the Installation

Pick an InstallConfig (official first-party configs via `GET /api/v1/install-configs`, or the Space's own). An InstallConfig
is the service-side Capsule config carrying `modulePath`, `normalization`, variable mapping, output allowlist, and
policy.

```bash
curl -s "$BASE/api/v1/install-configs" -H "$AUTH"

curl -s -X POST "$BASE/api/v1/spaces/<spaceId>/installations" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"hello","environment":"production","sourceId":"<sourceId>","installConfigId":"<installConfigId>"}'
```

## 5. Compatibility Check

Compatibility Check pins the SourceSnapshot and runs the Capsule Normalizer and Capsule Gate without provider credentials. If the host has no runner-backed source reader wired, the report contains a `capsule_source_files_unavailable` warning.

```bash
curl -s -X POST "$BASE/api/v1/sources/<sourceId>/compatibility-check" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"sourceSnapshotId":"<sourceSnapshotId>"}'
# -> {"report":{"id":"compat_...","level":"ready" | "auto_capsulized" | "needs_patch" | "unsupported", ...}}

curl -s "$BASE/api/v1/compatibility-reports/<reportId>" -H "$AUTH"
```

## 6. Plan, approve (when gated), apply

This API surface is the canonical Run contract. On a local service without runner-backed plan/apply configured, the Run may stay queued, fail, or return an adapter-unavailable response.

```bash
curl -s -X POST "$BASE/api/v1/installations/<installationId>/plan" -H "$AUTH"
# the platform pipeline pins the SourceSnapshot + Compatibility Report + DependencySnapshot and runs tofu plan from the generated root

curl -s "$BASE/api/v1/runs/<runId>" -H "$AUTH"
# waiting_approval only for destroy plans / destructive changes:
curl -s -X POST "$BASE/api/v1/runs/<runId>/approve" -H "$AUTH"
```

Apply only executes the saved plan after verifying the plan digest, source snapshot,
compatibility report, dependency snapshot, and state generation. Success advances the StateSnapshot generation and
records an OutputSnapshot and a Deployment.

```bash
curl -s "$BASE/api/v1/installations/<installationId>/deployments" -H "$AUTH"
curl -s "$BASE/api/v1/spaces/<spaceId>/activity" -H "$AUTH"
```

## 6. Check billing mode

Billing is a Space-scoped ledger. Use `disabled` for self-host/local dev, `showback` when you want estimates and usage without blocking, and `enforce` when hosted apply should be gated by credit reservation. This quickstart checks the ledger surface.

```bash
curl -s "$BASE/api/v1/spaces/<spaceId>/billing" -H "$AUTH"
curl -s "$BASE/api/v1/spaces/<spaceId>/usage" -H "$AUTH"
```

The dashboard's add flow (`/new`: catalog + Git URL form) drives the same steps from the UI. External install links (`/install?git=...&ref=...&path=...`) forward their query to `/new`, landing with the source pre-filled (pre-fill only — adding always requires explicit confirmation).

## Next

- [Model](../reference/model.md)
- [Control Plane API](../reference/deploy-control-api.md)
- [Operator](../reference/operator.md)
