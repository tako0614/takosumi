# Takosumi

Takosumi is a server that adds Git-hosted OpenTofu and Terraform software to
the clouds you connect, much like installing an app. Before anything is added
or updated, you can see how many resources will be created, changed, and
deleted.

Your modules and providers stay unchanged, and there is no Takosumi-specific
configuration language.

## What you can do

- **Pick and add** — choose a service from the Store or a Git URL, then fill in
  the connections and settings it needs.
- **Check before deploying** — see how many resources will be created, changed,
  and deleted before anything is deployed. Changes that delete, replace, or
  import something wait until you approve them.
- **Keep keys out of modules** — cloud API keys and tokens are stored in
  Takosumi. Their values cannot be read back and reach the runner only while a
  review or deploy is running.
- **Keep a record you can go back to** — Takosumi records which Git commit was
  deployed, by whom, and what changed. Each deploy keeps the state as a version,
  with its outputs, and going back to an earlier version's source is a change
  you review before it is deployed.

## Getting started

Pick the entry point that matches what you want to do.

- **Use the hosted service** — sign in at [app.takosumi.com](https://app.takosumi.com/)
  and add a service from the **Store**, or enter a Git URL under
  **Add from a Git repository**. The Takosumi hosted service is Pre-GA (not
  yet generally available). Steps, pricing, availability, and support are in
  the [hosted service documentation](https://app.takosumi.com/docs/en/).
- **Try adding and deploying locally** — follow the
  [Quickstart](./getting-started/quickstart.md) to start the dashboard, sign-in,
  database, and runner on Linux with Docker and Bun. It uses `sudo` to set up a local
  certificate authority and DNS. The sample creates no external resources, so
  you need no cloud credentials.
- **Run it in your own environment** — choose a shape in
  [Running it yourself](./concepts/self-host.md). The Cloudflare template includes
  a runner; the Bun + PostgreSQL template needs a separately composed runner for
  plan and apply.
- **Run only the API** — for checking the API during development, start an
  in-memory API server with [Run only the API](./getting-started/api-only.md).

## How it works

In the dashboard, what you pick in the Store and add is a **service**, and the
services you add are listed under **Workloads**. A service's own screen, opened
from Home, is an **app**. The docs and the API call an added service a
**Capsule**: one unit of deployment that bundles a Git URL, ref, and module path
with its variables and connections ([Glossary](./reference/glossary.md)). Each
change to a Capsule is recorded as two Runs: a plan (shown as Review) and an
apply (shown as Deploy). The apply Run is pinned to the reviewed plan Run
(`planRunId`), so the changes you read are the changes that are deployed.

Adding or updating something goes through these steps:

1. Name the Git URL and module.
2. Check the connections and inputs.
3. Plan the changes.
4. Review the changes, and approve them if they delete, replace, or import
   something.
5. Deploy the changes (apply).
6. Save the state, outputs, and history.

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
  [Store API](./reference/store-api.md), [API](./reference/api.md),
  [CLI](./reference/cli.md), and [Configuration](./reference/configuration.md) references

The old Resource Shape / Form Host API is documented only in the
[Resource migration note](./concepts/resources.md); it is not a new authoring
surface.
