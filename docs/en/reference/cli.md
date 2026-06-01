# CLI Reference {#cli-reference}

`takosumi` is a thin Installer API client.

```text
takosumi install --space <id> --source <source>
takosumi install dry-run --space <id> --source <source>
takosumi deploy <installation-id> [--source <source>]
takosumi deploy dry-run <installation-id> [--source <source>]
takosumi rollback <installation-id> <deployment-id>
takosumi server [--port 8788]
takosumi init [output]
takosumi version
```

Source syntax:

```text
git:<url>#<ref>
prepared:<url>#<sha256:hex>
<local-path>
```

Expected guard flags:

| Flag | Applies to |
| --- | --- |
| `--expected-plan-snapshot-digest` | Reviewed dry-run InstallPlan snapshot |
| `--expected-commit` | git source |
| `--expected-source-digest` | prepared source |
| `--expected-current-deployment-id` | deploy base pointer |

`takosumi init` creates a generic repo metadata starter, not a Takosumi-specific source DSL.

Configuration precedence is flag, then env, then `~/.takosumi/config.yml`.
