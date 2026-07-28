# What Takosumi is

Takosumi is a control plane that runs the OpenTofu / Terraform modules you keep in
Git — **plan, review, apply** — and keeps the history.
Takosumi does not ship a first-party Terraform/OpenTofu provider.

It does not build infrastructure itself. Cloudflare and AWS are still driven by their
own providers. What Takosumi takes on is the record of **who ran what, when, with which
credentials, and what came out of it**.

## What changes

Starting from writing `.tf` and running `tofu apply`, you gain the following.

**One module, different connections.** Modules carry no credentials and no notion of
environment. Create two Capsules — one for development, one for production — and give
each its own Connection. The `.tf` stays single.

**A review step before every apply.** You create a plan, read it, and then apply **that
same plan**. Nothing is re-planned at apply time, so what you reviewed is what runs.

**A trail you can follow later.** Every Run records the commit, the actor, the time, and
the credentials used. Each apply saves the resulting state, so you can go back.

**Fewer places credentials live.** Stored values cannot be read back. They reach only the
sandbox during a Run, and only the variable names appear in the record.

**Services that can reference each other.** A value one Capsule publishes can be consumed
by another, so endpoints are never copied by hand.

## What using it looks like

```bash
# 1. register the repository
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/sources" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN" \
  -H 'content-type: application/json' \
  -d '{ "workspaceId": "ws_example", "name": "my-app",
        "url": "https://github.com/example/my-app.git",
        "defaultRef": "v1.0.0", "defaultPath": "deploy/opentofu" }'

# 2. create a plan
curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/capsules/cap_example/plan" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"

# 3. read it, then apply the same Run
takosumi status run_example

curl -X POST "$TAKOSUMI_DEPLOY_CONTROL_URL/api/v1/runs/run_example/apply" \
  -H "authorization: Bearer $TAKOSUMI_DEPLOY_CONTROL_TOKEN"
```

The dashboard covers the same path: paste a Git URL into `/new`, and Takosumi reads the
module and shows the variables and providers it needs.

## Your module stays ordinary

There is no Takosumi manifest and nothing to add to your `.tf`. Register the module you
already run.

There is also an optional path for typed services — object storage, KV, SQL, queues —
declared without writing a module at all. Takosumi works without it.

## When it fits

- Several people touch the same infrastructure and you need **who did what**
- Development and production should run the **same module with different connections**
- Every apply should pass through **a human review**
- Cloud credentials **should not sit in a shell or a CI variable**

If you are one person on one environment and `tofu apply` is enough, this adds little.

## Where to go next

Start with the [Quickstart](./getting-started/quickstart.md) and get one thing running
locally.

To understand how it works, read the [Overview](./concepts/) and carry on through Sources
and Capsules, the Run model, state and outputs, and credentials.

When you need exact arguments and limits, they are in the [API](./reference/api.md) and
[CLI](./reference/cli.md) references.

Pricing and managed resources for the official hosted service live in the
[Takosumi Cloud docs](https://app.takosumi.com/docs/en/).
