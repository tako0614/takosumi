# Takosumi Cloud

Takosumi Cloud is hosted Takosumi for running OpenTofu modules from Git and
connecting them to the cloud services they need. A Workspace keeps the plan,
apply, state, outputs, audit, usage, and prepaid credit together.

> **Status:** Pre-GA. Code or a catalog entry does not mean a service is
> available. The Dashboard and the authenticated Cloud catalog expose the
> current `available` state.

## Your first deployment

1. Sign in to the [Dashboard](https://app.takosumi.com/) and select a Workspace.
2. Add a repository from the Store or by Git URL.
3. Select the provider connections required by the module.
4. Review the plan and quote, then apply it.
5. Open the service from the Run outputs or an Interface published by the app.

```text
Git repository
  → OpenTofu plan / review / apply
  → provider control plane
  → state + typed Output
  → authorized Interface
```

Cloudflare, AWS, Takoform, and other providers are ordinary peers from the
runner's point of view. Each provider control plane owns the lifecycle of the
objects it creates. Takosumi does not duplicate those objects into a second
resource ledger.

## What Takosumi Cloud owns

Takosumi Cloud provides:

- the hosted dashboard, Accounts, runner, state, outputs, and audit;
- provider connections and runner-only credential materialization;
- prepaid credit, usage, quota, and spend guards;
- available hosted services and standard protocol endpoints; and
- Interface and InterfaceBinding authorization for deployed services.

Cloud availability, price, capacity, billing, and support are separate from
Takoform Form maturity. Publishing a provider or schema alone does not enable
a Cloud service.

## Takoform

Takosumi Cloud intends to be the official Takoform Host, but the current Host
candidate is unpublished and unmounted. Pre-release FormRefs, schema digests,
and Host routes are not advertised as production capabilities.

After release, Takoform will still be an ordinary provider rather than a hidden
runner mode. The Cloud default uses ProviderConnection and ProviderBinding, and
users may replace it with their own compatible Host connection.

## Data endpoints

Takosumi Cloud can expose S3-compatible object access and OpenAI-compatible AI
access for existing services. These are data paths, not creation APIs. The
repository's provider graph owns lifecycle; outputs and Interfaces provide the
endpoint and authorization.

- [Resources and providers](./resources.md)
- [Data endpoints](./endpoints.md)
- [Pricing](./pricing.md)
- [Support](./support.md)
- [SLA](./sla.md)
- [Takosumi software docs](https://takosumi.com/docs/en/)
