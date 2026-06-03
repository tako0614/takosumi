# CLI

CLI は Deploy Control API の薄い client です。OpenTofu configuration を解釈する正本ではありません。

## Common env

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

`plan` は PlanRun response だけを表示します。`install` は PlanRun を作り、review 済み expected guard から ApplyRun を作ります。

## Deploy existing Installation

```bash
takosumi plan --installation ins_01ABCDEF
takosumi deploy ins_01ABCDEF
```

source を差し替える場合:

```bash
takosumi plan --installation ins_01ABCDEF \
  --source git:https://github.com/example/module.git#v2 \
  --provider registry.opentofu.org/cloudflare/cloudflare
```

## Guard override

CI で review 済み digest を pin する場合だけ使います。

```bash
takosumi install git:https://github.com/example/module.git#main \
  --space space_personal \
  --provider registry.opentofu.org/cloudflare/cloudflare \
  --expected-source-commit 0123456789abcdef0123456789abcdef01234567 \
  --expected-plan-digest sha256:<64 lowercase hex> \
  --expected-plan-artifact-digest sha256:<64 lowercase hex> \
  --expected-provider-lock-digest sha256:<64 lowercase hex>
```

`--provider` は repeatable です。RunnerProfile が provider allowlist を持つ場合、review 済み OpenTofu provider source address を PlanRun 作成時に申告します。

## Server

```bash
TAKOSUMI_DEPLOY_CONTROL_TOKEN=<token> takosumi server --port 8788
```

`--detach` は process を fork しません。systemd / container supervisor の template を表示します。
