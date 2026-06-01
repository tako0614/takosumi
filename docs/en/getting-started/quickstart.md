# Quickstart {#quickstart}

## Requirements

- Node.js 20+ / npm or Bun

This guide verifies that a local Takosumi server can create an Installation and first Deployment from a source root.

## Install the CLI

```bash
npm install -g @takosjp/takosumi
takosumi version
```

## Create a source root

```bash
mkdir hello-takosumi && cd hello-takosumi
printf '{"name":"hello-takosumi","version":"0.1.0"}\n' > package.json
```

`package.json` is generic repository metadata, not Takosumi-specific metadata.

## Start a local server

In another shell:

```bash
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
TAKOSUMI_DEV_MODE=1 takosumi server --port 8788
```

Back in the source shell:

```bash
export APP_ROOT="$PWD"
export TAKOSUMI_REMOTE_URL=http://localhost:8788
export TAKOSUMI_INSTALLER_TOKEN=dev-installer-token
```

## Dry-run

```bash
takosumi install dry-run --space space_personal --source "$APP_ROOT"
```

The response contains `installPlan`, `planSnapshotDigest`, `changes[]`, and `expected`.

## Apply

```bash
takosumi install --space space_personal --source "$APP_ROOT"
```

To apply the reviewed dry-run:

```bash
takosumi install --space space_personal --source "$APP_ROOT" \
  --expected-plan-snapshot-digest sha256:<copied-from-dry-run>
```

## Next

- [Installer API](../reference/installer-api.md)
- [CLI](../reference/cli.md)
- [Platform Services](../reference/platform-services.md)
