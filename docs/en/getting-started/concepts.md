# Concepts {#concepts}

## What is Takosumi?

Takosumi is a PaaS that reads a manifest (a declaration file called `.takosumi.yml`) and deploys your entire app. It is similar to Docker Compose, but with one key difference: the manifest only says WHAT you need, never WHERE it runs. The operator (the person or team running the platform) decides the execution target, so the same manifest works on Cloudflare, AWS, or bare metal.

## Inside a manifest

```yaml
# .takosumi.yml
apiVersion: v1
metadata:
  id: com.example.my-app
  name: my-app
components:
  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
  db:
    kind: postgres
    spec:
      version: "16"
```

| Key          | Meaning                                                                              |
| ------------ | ------------------------------------------------------------------------------------ |
| `components` | Individual pieces of your app. The example above has two: `web` and `db`             |
| `kind`       | The definition used by the component. `worker` runs code, `postgres` stores data     |
| `spec`       | Settings specific to the kind. A worker needs `entrypoint`, postgres needs `version` |

## Connecting Components With `connect` {#connect-components}

Components connect to each other with `connect`.

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"

  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    connect:
      db:
        output: db.connection
        inject: env
        prefix: DB
```

`web` consumes the `db.connection` output.

What actually happens: the `web` worker receives these environment variables.

```
DB_HOST=...
DB_PORT=5432
DB_USER=...
DB_PASSWORD=...
```

The `prefix: DB` becomes the prefix of each variable name. Your code reads them as ordinary environment variables.

Use `listen.path` for one known operator-provided service outside the manifest.

```yaml
listen:
  identity:
    path: identity.primary.oidc
    inject: secret-env
    prefix: IDENTITY
```

For targets that may have many visible providers, such as MCP servers, omit the
path and use `listen.kind` with `many: true`.

```yaml
listen:
  tools:
    kind: mcp-server@v1
    many: true
    inject: config-mount
```

`path` is not a URL path. It names one exact target inside a Space. In one
Space, one path can have only one active provider. For "all MCP servers" and
similar cases, use `kind` + `many: true` instead of a path. `kind` is the
selector field for both components and publications; there is no separate
manifest `type` selector.

## Installation and Deployment {#installation-deployment}

When you deploy a manifest, two kinds of records are created.

| Concept                       | Role                                                                       |
| ----------------------------- | -------------------------------------------------------------------------- |
| Installation (install record) | A management record tied to a Space (a deployment group). One per manifest |
| Deployment (deploy history)   | A history entry created each time you apply changes                        |

One Installation can have many Deployments, and each Deployment is kept as history. A rollback simply points back to an earlier successful Deployment.

```text
manifest
  -> create Installation
  -> Deployment #1 (initial)
  -> Deployment #2 (code update)
  -> Deployment #3 (config change)
  -> rollback → back to Deployment #2
```

Deploys go through the Installer API (5 HTTP endpoints). The CLI, GitHub Actions, or your own scripts all call the same API.

## Next {#next}

- [Quickstart](./quickstart.md) -- deploy something for real
- [Manifest Reference](../reference/manifest.md) -- every field explained
- [Reading Paths](./reading-paths.md) -- suggested routes by goal
