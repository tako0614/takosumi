# Quickstart

この手順は local Takosumi service に OpenTofu module の PlanRun / ApplyRun を作る最小例です。

## Prerequisites

- Bun
- OpenTofu CLI (`tofu`)
- Git

## 1. service を起動

```bash
cd takosumi
bun install

export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
bun src/cli/main.ts server --port 8788
```

別 terminal で CLI を叩きます。

```bash
cd takosumi
export TAKOSUMI_REMOTE_URL=http://127.0.0.1:8788
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token
```

## 2. OpenTofu module を用意

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

## 3. PlanRun を作る

```bash
cd takosumi
bun src/cli/main.ts plan /tmp/hello-takosumi \
  --space space_personal \
  --remote "$TAKOSUMI_REMOTE_URL" \
  --token "$TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

Plan command は PlanRun response を表示します。`status: "succeeded"`、`planDigest`、`sourceDigest`、`variablesDigest`、`policyDecisionDigest` が apply guard の入力になります。

## 4. ApplyRun を作る

```bash
cd takosumi
bun src/cli/main.ts install /tmp/hello-takosumi \
  --space space_personal \
  --remote "$TAKOSUMI_REMOTE_URL" \
  --token "$TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

CLI は PlanRun response から expected guard を組み立てて apply します。review した plan と違う source / variables / policy decision / plan digest では ApplyRun が作れません。

## Source syntax

```text
local path:
  /path/to/module

git repo:
  git:https://github.com/example/module.git#main

prepared archive:
  prepared:https://example.com/module.tar.gz#sha256:<64 lowercase hex>
```

module path が必要な場合は API request の `source.modulePath` で渡します。

## 次

- [Model](../reference/model.md)
- [Deploy Control API](../reference/deploy-control-api.md)
- [Runner profiles](../reference/runner-profiles.md)
