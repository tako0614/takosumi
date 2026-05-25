# Concepts {#concepts}

## What is Takosumi?

Takosumi is a PaaS that reads a manifest (a declaration file called `.takosumi.yml`) and deploys your entire app.
It is similar to Docker Compose, but with one key difference: the manifest only says WHAT you need, never WHERE it runs.
The operator (the person or team running the platform) decides the execution target, so the same manifest works on Cloudflare, AWS, or bare metal.

## Inside a manifest

```yaml
# .takosumi.yml
apiVersion: v1
metadata:
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

| Key         | Meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `component` | An individual piece of your app. The example above has two: `web` and `db` |
| `kind`      | The type of piece. `worker` is a code runtime, `postgres` is a database |
| `spec`      | Settings specific to the kind. A worker needs `entrypoint`, postgres needs `version` |

## Connecting with publish / listen {#publish-listen}

Components connect to each other through publish (offer) and listen (consume).

```yaml
components:
  db:
    kind: postgres
    spec:
      version: "16"
    publish:
      connection: {}

  web:
    kind: worker
    spec:
      entrypoint: src/worker.ts
    listen:
      db:
        from: db.connection
        prefix: DB
```

`db` publishes `connection`, and `web` listens to it.

What actually happens: the `web` worker receives these environment variables.

```
DB_HOST=...
DB_PORT=5432
DB_USER=...
DB_PASSWORD=...
```

The `prefix: DB` becomes the prefix of each variable name. Your code reads them as ordinary environment variables.

## Installation and Deployment {#installation-deployment}

When you deploy a manifest, two kinds of records are created.

| Concept                        | Role                                                        |
| ------------------------------ | ----------------------------------------------------------- |
| Installation (install record)  | A management record tied to a Space (a deployment group). One per manifest |
| Deployment (deploy history)    | A history entry created each time you apply changes         |

One Installation can have many Deployments, and each Deployment is kept as history. A rollback is simply pointing back to an earlier successful Deployment.

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
