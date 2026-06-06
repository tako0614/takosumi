# Quickstart

Run a local Takosumi service, create an Installation directly under a Space, and plan / apply it (core-spec §23).

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

curl -s -X POST "$BASE/api/sources/<sourceId>/sync" -H "$AUTH"
# the source_sync Run pins the ref to a commit and records a SourceSnapshot
```

## 3. Create the Installation

Pick an InstallConfig (official first-party configs via `GET /api/install-configs`, or the Space's own).

```bash
curl -s "$BASE/api/install-configs" -H "$AUTH"

curl -s -X POST "$BASE/api/spaces/<spaceId>/installations" -H "$AUTH" -H 'content-type: application/json' \
  -d '{"name":"hello","environment":"production","sourceId":"<sourceId>","installConfigId":"<installConfigId>"}'
```

## 4. Plan, approve (when gated), apply

```bash
curl -s -X POST "$BASE/api/installations/<installationId>/plan" -H "$AUTH"
# pins the SourceSnapshot + DependencySnapshot and evaluates the plan JSON policy layers

curl -s "$BASE/api/runs/<runId>" -H "$AUTH"
# waiting_approval only for destroy plans / destructive changes:
curl -s -X POST "$BASE/api/runs/<runId>/approve" -H "$AUTH"
```

Apply only executes the saved plan after verifying the plan digest, source snapshot, dependency snapshot, and state generation. Success advances the StateSnapshot generation and records an OutputSnapshot and a Deployment.

```bash
curl -s "$BASE/api/installations/<installationId>/deployments" -H "$AUTH"
curl -s "$BASE/api/spaces/<spaceId>/activity" -H "$AUTH"
```

The dashboard's Install-from-Git flow (prefilled by `/install?git=...&ref=...&path=...` links) drives the same steps from the UI.

## Next

- [Model](../reference/model.md)
- [Control Plane API](../reference/deploy-control-api.md)
- [Runner profiles](../reference/runner-profiles.md)
