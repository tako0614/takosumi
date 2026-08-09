# Takosumi

Takosumi is a server that runs Git-hosted OpenTofu and Terraform modules through
a **plan → review → apply** workflow. It keeps the commit, proposed changes,
state, outputs, and actor in a history you can inspect later.

Your modules and providers stay unchanged. There is no Takosumi-specific
configuration language.

Takosumi does not ship a first-party Terraform/OpenTofu provider.

## Why use it

### Apply only what you reviewed

Takosumi treats the plan and apply as one Run. It does not silently create a
different plan after review, so the changes you read are the changes it applies.

### Keep credentials out of modules

Cloud API keys and tokens are stored in Takosumi. Their values cannot be read
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

## Try the API

You can start the API in about five minutes. This development setup keeps data
in memory.

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
curl http://127.0.0.1:8788/v1/capabilities \
  -H "authorization: Bearer dev-token"
```

The [Quickstart](./getting-started/quickstart.md) starts the dashboard, sign-in,
durable database, and OpenTofu runner.

## Where to go next

- [Concepts](./concepts/index.md) — the small set of terms and the deployment lifecycle
- [Sources and Capsules](./concepts/sources.md) — pinning a Git ref to a commit
- [Run model](./concepts/run-model.md) — plan, approval, apply, and destroy
- [Credentials](./concepts/credentials.md) — passing connections to providers
- [Interfaces](./concepts/interfaces.md) — describing connections and granting use
- [Self-hosting](./concepts/self-host.md) — operating a production installation
- [Repository manifest](./reference/repository-manifest.md),
  [Store API](./reference/store-api.md), [API](./reference/api.md), and
  [CLI](./reference/cli.md) references

The old Resource Shape / Form Host API is documented only in the
[Resource migration note](./concepts/resources.md); it is not a new authoring
surface.

Pricing, Cloud resources, and support for the official hosted service are in
the [Takosumi Cloud documentation](https://app.takosumi.com/docs/en/).
