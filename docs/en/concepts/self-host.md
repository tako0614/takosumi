# Running it yourself

Takosumi can sit in your own environment and serve as your own endpoint. The software is
published under AGPL-3.0. The control plane, accounts, and dashboard share the origin users
connect to. OpenTofu runner and source/artifact/state persistence vary by composition. The
CLI, dashboard, Takoform clients, and other API clients talk to that origin.

The repository's `deploy/` directory holds three templates that differ in where they put
things.

## Choosing a shape

| Shape and template | Plan and apply | Where it runs | Where state lives |
| --- | --- | --- | --- |
| **Cloudflare**<br>`deploy/platform/` | Plan, yes. Apply and destroy need digests from the release tool ([About apply and destroy](../self-host/cloudflare.md#about-apply-and-destroy)) | Cloudflare Workers | D1 / R2 / Durable Objects |
| **Bun and PostgreSQL**<br>`deploy/node-postgres/` | Only once you compose in a runner | A VM or a container | PostgreSQL |
| **Local only**<br>`deploy/local-substrate/` | Yes, with `--profile postgres` (a bundled runner container) | Your own Linux and Docker | Compose volumes |

**Cloudflare** suits you when you would rather not keep servers. You need a Cloudflare
account on the Workers Paid plan and a domain whose DNS Cloudflare manages. OpenTofu
execution is taken on by a runner in a Cloudflare Container. Accounts, the control
plane, the dashboard, and the runner all sit in one Worker.

**Bun and PostgreSQL** suits you when it should live on your own infrastructure. You need
a host running Docker, PostgreSQL, and Caddy to terminate TLS. The bundled
`docker-compose.yml` brings up PostgreSQL, the migrations, the service itself, and Caddy
together. It does not include an OpenTofu runner, so plan and apply need a runner composed
in separately.

**Local only** is for exercising the whole thing without exposing anything. You need
Linux, Docker, Bun, and `sudo` to set up certificates and DNS. Pebble for ACME, CoreDNS,
and Caddy come up on the same Docker network, and `*.takosumi.test` resolves the same way
it would in production.

## Costs

The Takosumi software has no fee (AGPL-3.0). What you pay for is where you run Takosumi and the
resources that the apps you add create.

- **Cloudflare** — Cloudflare bills the Workers Paid plan and your usage of Workers, Containers,
  D1, R2, Durable Objects, and logs (observability). Loading the dashboard also counts as Worker
  requests. A domain costs extra. See Cloudflare's
  [Workers pricing](https://www.cloudflare.com/plans/developer-platform/) and
  [Containers pricing](https://developers.cloudflare.com/containers/platform/pricing/) for
  amounts.

  The runner container (2 vCPU, 6 GiB, and 10 GB disk in the template, at most 10 instances)
  starts for a review, a deploy, a deletion, a repository fetch, a pre-add check, and a restore,
  backup, or stable-tag lookup that a user requests. Repositories that sync automatically also
  start it at the hourly check. Drift checks and automatic reviews of services with updates start
  it only when you enable them. Each time, it stops when that work ends or after about 30 seconds
  without activity.
- **Bun and PostgreSQL** — the server that runs Docker, and PostgreSQL. Plan and apply also need a
  separately composed runner, which costs whatever it runs on.
- **Entirely local** — Takosumi itself runs only on your own machine.
- **Resources of the apps you add** — the Workers, buckets, databases, and so on that an app
  creates are billed to the connected account by its provider, such as Cloudflare.

## Procedures

- [Putting it on Cloudflare](../self-host/cloudflare.md)
- [Putting it on Bun and PostgreSQL](../self-host/bun-postgres.md)
- Running it entirely locally (below)

## Running it entirely locally

This runs the whole thing on your own Linux machine with nothing exposed.

```bash
cd deploy/local-substrate
bash scripts/up.sh --profile postgres
sudo bash scripts/ca-install.sh
sudo bash scripts/configure-dns.sh
bash scripts/smoke.sh
```

`ca-install.sh` installs Pebble's root CA into the host trust store and into the NSS
databases of Chrome and Firefox. Pebble regenerates its root every time its container
starts. After `down.sh` and a new `up.sh`, or when certificate errors appear after the
host restarts, run `ca-install.sh` again and restart the browser. The
[Quickstart](../getting-started/quickstart.md) explains what both scripts change and how
to undo them.

## Confirming it works

First, see that the process answers.

```bash
curl -s https://takosumi.example.com/healthz
```

Next, see that its dependencies are in place. On the Cloudflare shape, `/readyz` inspects
the bindings and returns `503` naming anything missing.

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://takosumi.example.com/readyz
```

On the Bun and PostgreSQL shape, `/readyz` returns `503` with `internalApiSecret` in its reason
unless `TAKOSUMI_INTERNAL_API_SECRET` is set. The bundled Compose does not pass it, and nothing
but this check uses it today. A `200` from `/healthz` means the process finished its startup
checks (sealing key, signing key, upstream provider settings) and PostgreSQL answers; it does
not check the upstream identity provider or the dashboard. How to make `/readyz` pass too is in
[Putting it on Bun and PostgreSQL](../self-host/bun-postgres.md#making-readyz-pass).

OIDC discovery shows whether the foundation for signing in is standing. When `issuer`
comes back with the same value as `TAKOSUMI_ACCOUNTS_ISSUER`, the configuration is right.

```bash
curl -s https://takosumi.example.com/.well-known/openid-configuration
```

Product discovery tells you what this endpoint has enabled.

```bash
curl -s https://takosumi.example.com/.well-known/takosumi
curl -s https://takosumi.example.com/api/v1/capabilities
```

With that much working, read real data once. Sign in to the dashboard, create an API key
with **Read** (untick **Restrict this key to the current Workspace** if it is
shown), as in [Creating a token](../reference/cli.md#creating-a-token), and list the
Workspaces. Export the key as `TAKOSUMI_READ_TOKEN`. Scopes do not include one another, so a `write`-only token gets `403` here. Use
the token you created, not the operator-only `TAKOSUMI_DEPLOY_CONTROL_TOKEN`. A `200` means
authentication and reading the records both work.

```bash
curl -s -H "authorization: Bearer $TAKOSUMI_READ_TOKEN" \
  https://takosumi.example.com/api/v1/workspaces
```

Finally, deploy something once on a composition that includes a runner. Put a Git URL into `/new` in the dashboard, create a plan,
read it, and apply. A successful Run that leaves a StateVersion and Outputs behind means
the runner and the state backend work too. On Cloudflare without the three digests, check up
to creating the plan, as described in [About apply and destroy](../self-host/cloudflare.md#about-apply-and-destroy). `examples/opentofu-basic` needs no provider
credentials and is a good fit for this check.

## What to decide next

At this point the endpoint runs. What it makes available is then up to you. The runner
profiles you enable, the upper limit on Sources picked up per scheduled poll, the deletion
grace period, and how secrets are stored are all settings. The list of variables and how to
choose them is in the [configuration reference](/en/reference/configuration).

What you end up taking on from the point of view of the people using that endpoint is set
out in [Product boundaries](./boundaries.md).

[operations guide](../self-host/index.md)
