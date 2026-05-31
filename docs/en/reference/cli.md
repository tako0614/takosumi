# CLI {#cli}

The `takosumi` CLI is a thin client for the five-endpoint [Installer API](./installer-api.md). It sends source, shows dry-run output, applies deployments, rolls back, and can start a local server for development.

## Install

```bash
deno install -gA -n takosumi npm:@takosjp/takosumi
takosumi version
```

## Authentication {#authentication}

Remote commands use an installer bearer token.

| Env                        | Purpose                     |
| -------------------------- | --------------------------- |
| `TAKOSUMI_INSTALLER_TOKEN` | Five-endpoint Installer API |

Token resolution order:

1. command flag (`--token`)
2. `TAKOSUMI_INSTALLER_TOKEN`
3. `~/.takosumi/config.yml` `token`

Remote URL resolution uses `--remote`, `TAKOSUMI_REMOTE_URL`, or `~/.takosumi/config.yml` `remote_url`.

## Commands {#commands}

### `takosumi install --source <source>`

Create a new Installation.

```bash
takosumi install --remote https://kernel.example.com \
  --space space_personal \
  --source git:https://github.com/example/notes#v1.2.3
```

Source grammar:

```text
git:<url>#<ref>
prepared:<url>#<sha256:hex>
<local-path>
```

`local` source is for development or operator-local use when the server process can see the same path. `git` source requires `#<ref>`, and `prepared` source requires `#<sha256:hex>`.

Expected guard flags:

| Flag                         | Source kind                    |
| ---------------------------- | ------------------------------ |
| `--expected-manifest-digest` | `git`, `prepared`, and `local` |
| `--expected-commit`          | `git`                          |
| `--expected-source-digest`   | `prepared`                     |

### `takosumi install dry-run --source <source>`

```bash
takosumi install dry-run --space space_personal --source .
```

Dry-run returns `expected` guards. Pass those guards to apply when automation needs to bind apply to the reviewed source.

### `takosumi deploy <installation-id> [--source <source>]`

Apply a new Deployment to an existing Installation. When `--source` is omitted, the operator reuses the immutable source record from the current Deployment. `local` source has no portable source byte identity, so provide `--source` each time for local deploy dry-run and apply.

```bash
takosumi deploy inst_01HM9N7XK4QY8RT2P5JZF6V3W9 \
  --source git:https://github.com/example/notes#v1.2.4
```

Deploy apply uses the source expected flags plus `--expected-current-deployment-id` from deploy dry-run. That pointer guard makes apply fail if another Deployment became current after review. If deploy dry-run returns `expected.currentDeploymentId: null`, pass the literal `null` to the CLI flag.

### `takosumi deploy dry-run <installation-id> [--source <source>]`

Preview an update without applying it. The response includes `expected.currentDeploymentId`.

### `takosumi rollback <installation-id> <deployment-id>`

Move the current pointer back to a previous succeeded Deployment.

```bash
takosumi rollback inst_01HM9N7XK4QY8RT2P5JZF6V3W9 dep_01HM9N7XK4QY8RT2P5JZF6V3WA
```

### `takosumi server`

Start a local server for development.

```bash
takosumi server
takosumi server --port 9000
```

### `takosumi init [output]`

Generate a manifest scaffold. `init` creates the manifest only; it does not generate runtime files or a build recipe.

## Config File {#config-file}

`~/.takosumi/config.yml`:

```yaml
remote_url: https://kernel.example.com
token: <installer-token>
```

Command flags override environment variables, which override the config file.

## Related Pages {#related-pages}

- [Installer API](./installer-api.md)
- [Manifest](./manifest.md)
- [Build Service Boundary](./build-spec.md)
