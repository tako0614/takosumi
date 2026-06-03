# @takosjp/takosumi/cli

Operator CLI for the OpenTofu-native Takosumi Deploy Control API.

## Install

```bash
npm install -g @takosjp/takosumi
takosumi version
```

## Quickstart

```bash
export TAKOSUMI_DEV_MODE=1
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-deploy-control-token
export TAKOSUMI_REMOTE_URL=http://localhost:8788

takosumi server --port 8788 &

mkdir hello-takosumi && cd hello-takosumi
git init
cat > main.tf <<'EOF'
output "app_url" {
  value = "https://example.test"
}
EOF

takosumi plan ./ --space space_personal
takosumi install ./ --space space_personal \
  --provider registry.opentofu.org/cloudflare/cloudflare
```

## Commands

| Command | Purpose |
| --- | --- |
| `takosumi plan <source> --space <id>` | create a PlanRun |
| `takosumi install <source> --space <id>` | create a PlanRun and ApplyRun |
| `takosumi deploy <installation-id> [--source <source>]` | create an update PlanRun and ApplyRun |
| `takosumi plan --installation <id> [--source <source>]` | create only the update PlanRun |
| `takosumi rollback <installation-id> <deployment-id>` | redeploy from a retained Deployment source |
| `--provider <source-address>` | repeat on plan/install/deploy/rollback to declare the reviewed OpenTofu providers before runner execution |
| `takosumi server [--port]` | boot the local Takosumi service |
| `takosumi migrate [--dry-run]` | run Takosumi service DB migrations |
| `takosumi init [<output>] [--template]` | optional OpenTofu module scaffold |
| `takosumi version` | print version |

## Env vars

Priority:

1. CLI flag (`--remote` / `--token`)
2. Command-specific env (`TAKOSUMI_DEPLOY_CONTROL_TOKEN`)
3. Remote URL env (`TAKOSUMI_REMOTE_URL`)
4. XDG config file

| Env var | Used by |
| --- | --- |
| `TAKOSUMI_REMOTE_URL` | default Takosumi service URL for remote CLI commands |
| `TAKOSUMI_DEPLOY_CONTROL_TOKEN` | bearer token for deploy control routes |
| `TAKOSUMI_DEV_MODE=1` | dev opt-out for strict production guards |

## See also

- `@takosjp/takosumi`
- `@takosjp/takosumi/contract`
- `@takosjp/takosumi/contract/deploy-control-api`
