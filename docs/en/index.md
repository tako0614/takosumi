# Takosumi

Takosumi is a server that runs Git-hosted OpenTofu and Terraform modules through
a **plan → review → apply** workflow. It keeps the commit, proposed changes,
state, outputs, and actor in a history you can inspect later.

Your modules and providers stay unchanged. There is no Takosumi-specific
configuration language.

Takosumi does not ship a first-party Terraform/OpenTofu provider.

## Why use it

### Apply only what you reviewed

Takosumi records plan and apply as separate Runs. The apply Run is pinned to the
reviewed plan Run with `planRunId`, so it does not silently create a different
plan after review and the changes you read are the changes it applies.

### Keep credentials out of modules

Takosumi API keys and tokens are stored in Takosumi. Their values cannot be read
back and are released only to the runner while the relevant Run is active. The
same module can serve development and production with different connections.

### Keep an execution history

Takosumi records which Git commit ran, who ran it, and what changed. Each apply
saves state and outputs for incident investigation and comparison.

## One Git/OpenTofu flow

Takosumi calls a registered Git module a **Capsule**. The supported OSS path is
one Stack flow: provide the Git URL, ref, module path, variables, and the
provider connections required by that module. Runs, state, outputs, and audit
history all belong to this flow.

```text
Git URL and module declaration
  → check inputs and connections
  → plan
  → review changes
  → apply
  → save state, outputs, and audit records
```

## Getting started

Pick the entry point that matches what you want to do.

- **Use the hosted service** — sign in at [app.takosumi.com](https://app.takosumi.com/)
  and add a repository from the Store or a Git URL. The hosted service is Pre-GA.
  Steps, pricing, availability, and support are in the
  [Takosumi hosted service documentation](https://app.takosumi.com/docs/en/).
- **Try plan through apply locally** — follow the
  [Quickstart](./getting-started/quickstart.md) to start the dashboard, sign-in,
  database, and runner on Linux with Docker. It uses `sudo` to set up a local
  certificate authority and DNS. The sample module creates no external resources,
  so you need no cloud credentials.
- **Run it in your own environment** — choose a shape in
  [Running it yourself](./concepts/self-host.md). The Cloudflare template includes
  a runner; the Bun + PostgreSQL template needs a separately composed runner for
  plan and apply.
- **Run only the API** — start it with the development setup below.

### Run only the API {#api-only}

This is for checking the API during development, and needs Bun and Git. Data
stays in memory and is lost on restart. The dashboard and runner do not start.

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install

TAKOSUMI_DEV_MODE=1 \
TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token \
PORT=8788 \
bun core/index.ts
```

In another terminal:

```bash
curl http://127.0.0.1:8788/api/v1/capabilities \
  -H "authorization: Bearer dev-token"
```

If it returns JSON, the API is running.

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
