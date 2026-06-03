# CLI

The CLI is a thin Deploy Control API client. It is not the source of truth for interpreting OpenTofu configuration.

## Common Env

```bash
export TAKOSUMI_REMOTE_URL=https://operator.example.com
export TAKOSUMI_DEPLOY_CONTROL_TOKEN=<token>
```

## Plan / Install

```bash
takosumi plan git:https://github.com/example/module.git#main \
  --space space_personal \
  --provider registry.opentofu.org/cloudflare/cloudflare

takosumi install git:https://github.com/example/module.git#main \
  --space space_personal \
  --provider registry.opentofu.org/cloudflare/cloudflare \
  --expected-plan-digest sha256:<64 lowercase hex>
```

`plan` prints only the PlanRun response. `install` creates a PlanRun, then creates an ApplyRun from the reviewed expected guard.

## Deploy Existing Installation

```bash
takosumi plan --installation ins_01ABCDEF
takosumi deploy ins_01ABCDEF
```

To replace the source:

```bash
takosumi plan --installation ins_01ABCDEF \
  --source git:https://github.com/example/module.git#v2 \
  --provider registry.opentofu.org/cloudflare/cloudflare
```

## Guard Override

Use these flags only when CI pins already reviewed digests.

```bash
takosumi install git:https://github.com/example/module.git#main \
  --space space_personal \
  --provider registry.opentofu.org/cloudflare/cloudflare \
  --expected-source-commit 0123456789abcdef0123456789abcdef01234567 \
  --expected-plan-digest sha256:<64 lowercase hex> \
  --expected-plan-artifact-digest sha256:<64 lowercase hex> \
  --expected-provider-lock-digest sha256:<64 lowercase hex>
```

`--provider` is repeatable. When the RunnerProfile has a provider allowlist, declare the reviewed OpenTofu provider source addresses when creating the PlanRun.

## Server

```bash
TAKOSUMI_DEPLOY_CONTROL_TOKEN=<token> takosumi server --port 8788
```

`--detach` does not fork the process. It prints a systemd / container supervisor template.
