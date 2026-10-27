# Takosumi hosted service

The Takosumi hosted service runs OpenTofu modules from Git and connects them to
the cloud services they need. A Workspace keeps the plan,
apply, state, outputs, audit, usage, and prepaid credit together.

> **Status:** Pre-GA. Code or a catalog entry does not mean a service is
> available. The Dashboard and the authenticated Takosumi catalog expose the
> current `available` state.

## Your first deployment

1. Sign in to the [dashboard](https://app.takosumi.com/) and select a workspace.
2. Choose an app in the **Store**. Git URLs and app install links open the same app detail.
3. Press **Install** to expand settings in place. Takosumi pins the Git revision,
   checks its module, and displays only the required setup, with declared defaults filled in.
   No app resources are created yet. Open advanced settings only when needed.
4. If a cloud connection is needed, press **Connect**. The inline panel lets you choose
   a verified connection or set up and verify a supported Provider. Closing it keeps app inputs.
5. Press **Install** below the settings. A known, non-destructive, policy-pass Plan
   requiring no additional approval continues to Apply. Other Plans stay in **Review installation**
   for explicit confirmation. Expand progress and logs, or reload to inspect the existing run.
   Reloading or opening a URL never grants Apply consent.
6. After **Installed**, **Open service** opens the app's authorized launch URL, when it has one.
   Otherwise use **Manage app**. Failures show recovery actions and can be retried with a new
   Plan without discarding partially created state.
7. **Uninstall** asks for confirmation before scheduling deletion. The service and its data
   remain during the grace period. The same screen shows progress and permits cancellation
   while the server allows it. Provider secrets and install inputs are not saved to browser storage.

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

## What the Takosumi hosted service owns

The Takosumi hosted service provides:

- the hosted dashboard, Accounts, runner, state, outputs, and audit;
- provider connections and runner-only credential materialization;
- prepaid credit, usage, quota, and spend guards;
- available hosted services and standard protocol endpoints; and
- Interface and InterfaceBinding authorization for deployed services.

Hosted-service availability, price, capacity, billing, and support are separate from
Takoform Form maturity. Publishing a provider or schema alone does not enable
a hosted service.

## Takoform

The Takosumi hosted service intends to be the official Takoform Host, but the current Host
candidate is unpublished and unmounted. Pre-release FormRefs, schema digests,
and Host routes are not advertised as production capabilities.

After release, Takoform will still be an ordinary provider rather than a hidden
runner mode. The hosted-service default uses ProviderConnection and ProviderBinding, and
users may replace it with their own compatible Host connection.

## Data endpoints

The Takosumi hosted service can expose S3-compatible object access and OpenAI-compatible AI
access for existing services. These are data paths, not creation APIs. The
repository's provider graph owns lifecycle; outputs and Interfaces provide the
endpoint and authorization.

- [Resources and providers](./resources.md)
- [Data endpoints](./endpoints.md)
- [Pricing](./pricing.md)
- [Support](./support.md)
- [SLA](./sla.md)
- [Takosumi software docs](https://takosumi.com/docs/en/)
