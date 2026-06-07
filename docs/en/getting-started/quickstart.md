# Quickstart

Run a local Takosumi service, create the control-plane records for an OpenTofu Capsule Installation directly under a Space, and inspect the Compatibility Check / Plan / Apply contract.

The completed canonical specification is [Core spec](../../core-spec.md). Runner-backed Capsule Normalizer / Capsule Gate, Compatibility Report apply guards, and billing enforcement are still being implemented. Do not read the local service flow as proof that real OpenTofu execution or credit-based apply blocking is complete. Current gaps are tracked in [Core conformance](../../core-conformance.md).

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

## 2. Register a Space and a Source

```bash
curl -s -X POST "$BASE/api/spaces" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"handle":"shota","displayName":"Shota","type":"personal","ownerUserId":"user_dev"}'

curl -s -X POST "$BASE/api/sources" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"spaceId":"<spaceId>","name":"hello","url":"https://git.example.com/example/hello.git","defaultRef":"main","defaultPath":"."}'
```

Replace `url` with a reachable Git repository containing a plain OpenTofu module-compatible configuration.

If the runner substrate is configured, create the SourceSnapshot. A SourceSnapshot pins the Git ref to an immutable commit input.

```bash
curl -s -X POST "$BASE/api/sources/<sourceId>/sync" -H "$AUTH"
# the source_sync Run pins the ref to a commit and records a SourceSnapshot
```

## 3. Create the Installation

Pick an InstallConfig (official first-party configs via `GET /api/install-configs`, or the Space's own). An InstallConfig
is the service-side Capsule config carrying `modulePath`, `normalization`, variable mapping, output allowlist, and
policy.

```bash
curl -s "$BASE/api/install-configs" -H "$AUTH"

curl -s -X POST "$BASE/api/spaces/<spaceId>/installations" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"hello","environment":"production","sourceId":"<sourceId>","installConfigId":"<installConfigId>"}'
```

## 4. Compatibility Check

Compatibility Check pins the SourceSnapshot and, in the completed pipeline, runs the Capsule Normalizer and Capsule Gate without provider credentials. The current local service may return a metadata-only report. That confirms the API contract; it does not mean the Runner-backed Gate is complete.

```bash
curl -s -X POST "$BASE/api/sources/<sourceId>/compatibility-check" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"sourceSnapshotId":"<sourceSnapshotId>"}'
# -> {"report":{"id":"compat_...","level":"ready" | "auto_capsulized" | "needs_patch" | "unsupported", ...}}

curl -s "$BASE/api/compatibility-reports/<reportId>" -H "$AUTH"
```

## 5. Plan, approve (when gated), apply

This API surface is the canonical Run contract. On a local service without runner-backed plan/apply configured, the Run may stay queued, fail, or return an implementation-in-progress response.

```bash
curl -s -X POST "$BASE/api/installations/<installationId>/plan" -H "$AUTH"
# in the completed pipeline, pins the SourceSnapshot + Compatibility Report + DependencySnapshot and runs tofu plan from the generated root

curl -s "$BASE/api/runs/<runId>" -H "$AUTH"
# waiting_approval only for destroy plans / destructive changes:
curl -s -X POST "$BASE/api/runs/<runId>/approve" -H "$AUTH"
```

In the completed pipeline, apply only executes the saved plan after verifying the plan digest, source snapshot, dependency snapshot, and state generation. Success advances the StateSnapshot generation and records an OutputSnapshot and a Deployment.

```bash
curl -s "$BASE/api/installations/<installationId>/deployments" -H "$AUTH"
curl -s "$BASE/api/spaces/<spaceId>/activity" -H "$AUTH"
```

## 6. Check billing mode

Billing is a Space-scoped ledger. Use `disabled` for self-host/local dev, `showback` when you want estimates and usage without blocking, and `enforce` when hosted apply should be gated by credit reservation. Billing enforcement is still being implemented, so this quickstart only checks the ledger surface.

```bash
curl -s "$BASE/api/spaces/<spaceId>/billing" -H "$AUTH"
curl -s "$BASE/api/spaces/<spaceId>/usage" -H "$AUTH"
```

The dashboard's Install OpenTofu Capsule flow (prefilled by `/install?git=...&ref=...&path=...` links) drives the same steps from the UI.

## Next

- [Model](../reference/model.md)
- [Control Plane API](../reference/deploy-control-api.md)
- [Operator](../reference/operator.md)
