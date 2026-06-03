# Quickstart

Run a local Takosumi service and deploy a small OpenTofu module.

## Prerequisites

- Bun
- OpenTofu CLI (`tofu`)
- Git

## Start the service

```bash
cd takosumi
bun install

export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
bun src/cli/main.ts server --port 8788
```

In another terminal:

```bash
cd takosumi
export TAKOSUMI_REMOTE_URL=http://127.0.0.1:8788
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
```

## Create a module

```bash
mkdir -p /tmp/hello-takosumi
cd /tmp/hello-takosumi

cat > main.tf <<'EOF'
terraform {
  required_version = ">= 1.6.0"
}

output "launch_url" {
  value = "https://example.test"
}
EOF

git init
git add main.tf
git commit -m "initial OpenTofu module"
```

## Plan and apply

```bash
cd takosumi
bun src/cli/main.ts plan /tmp/hello-takosumi \
  --space space_personal \
  --remote "$TAKOSUMI_REMOTE_URL" \
  --token "$TAKOSUMI_DEPLOY_CONTROL_TOKEN"

bun src/cli/main.ts install /tmp/hello-takosumi \
  --space space_personal \
  --remote "$TAKOSUMI_REMOTE_URL" \
  --token "$TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

The CLI builds the ApplyRun expected guard from the PlanRun response.
