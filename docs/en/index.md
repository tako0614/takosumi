# Takosumi

Takosumi is a server for adding Git-hosted OpenTofu and Terraform software to
the clouds you connect, the way you would add an app. Before anything is added
or updated, you can see what will be created and what will change.

Your modules and providers stay unchanged, and there is no Takosumi-specific
configuration language.

## What you can do

- **Pick and add** — choose an app from the Store or a Git URL, then fill in the
  connections and settings it needs.
- **Check before applying** — see how many resources will be created, changed,
  and deleted before anything is applied. Changes that delete, replace, or
  import something wait until you approve them.
- **Keep keys out of modules** — cloud API keys and tokens are stored in
  Takosumi. Their values cannot be read back and reach the runner only while a
  review or apply is running.
- **Keep a record you can go back to** — Takosumi records which Git commit was
  applied, by whom, and what changed. Each apply keeps the state as a version,
  with its outputs, and going back to an earlier version's source is a change
  you review before it is applied.

## Getting started

Pick the entry point that matches what you want to do.

- **Use the hosted service** — sign in at [app.takosumi.com](https://app.takosumi.com/)
  and add an app from the **Store**, or enter a Git URL under
  **Add from a Git repository**. The hosted service (Takosumi Hosted) is
  Pre-GA. Steps, pricing, availability, and support are in the
  [hosted service documentation](https://app.takosumi.com/docs/en/).
- **Try adding and applying locally** — follow the
  [Quickstart](./getting-started/quickstart.md) to start the dashboard, sign-in,
  database, and runner on Linux with Docker. It uses `sudo` to set up a local
  certificate authority and DNS. The sample creates no external resources, so
  you need no cloud credentials.
- **Run it in your own environment** — choose a shape in
  [Running it yourself](./concepts/self-host.md). The Cloudflare template includes
  a runner; the Bun + PostgreSQL template needs a separately composed runner for
  plan and apply.
- **Run only the API** — for checking the API during development, start an
  in-memory API server with [Run only the API](./getting-started/api-only.md).

## How it works

What the dashboard calls an app or a service, the docs and the API call a
**Capsule**: one unit of deployment that bundles a Git URL, ref, and module path
with its variables and connections ([Glossary](./reference/glossary.md)). Each
change to a Capsule is recorded as two Runs, a plan and an apply. The apply Run
is pinned to the reviewed plan Run with `planRunId`, so the changes you read are
the changes that are applied.

```text
Git URL and module declaration
  → check connections and inputs
  → plan (prepare the changes)
  → review and approve the changes
  → apply
  → save state, outputs, and history
```

Takosumi does not ship a first-party Terraform/OpenTofu provider. Cloudflare,
AWS, and others are operated by their existing providers.

## Where to go next

- [Concepts](./concepts/index.md) — the small set of terms and the deployment lifecycle
- [Sources and Capsules](./concepts/sources.md) — pinning a Git ref to a commit
- [Run model](./concepts/run-model.md) — plan, approval, apply, and destroy
- [Credentials](./concepts/credentials.md) — passing connections to providers
- [Interfaces](./concepts/interfaces.md) — describing connections and granting use
- [Running it yourself](./concepts/self-host.md) — operating a production installation
- [Repository manifest](./reference/repository-manifest.md),
  [Store API](./reference/store-api.md), [API](./reference/api.md), and
  [CLI](./reference/cli.md) references

The old Resource Shape / Form Host API is documented only in the
[Resource migration note](./concepts/resources.md); it is not a new authoring
surface.
