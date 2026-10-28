# Takosumi hosted service

The Takosumi hosted service runs OpenTofu modules from Git and connects them to
the cloud services they need. A Workspace keeps the plan,
apply, state, outputs, audit, usage, and prepaid credit together.

> **Status:** Pre-GA. Code or a catalog entry does not mean a service is
> available. The Dashboard and the authenticated Takosumi catalog expose the
> current `available` state.

## Your first install

1. Sign in to the [dashboard](https://app.takosumi.com/) and select a workspace.
2. Choose an app in the **Store**. Git URLs and app install links open the same app page.
3. Check the description and source, then press **Install**. Nothing is created in your cloud yet.
   Takosumi reads the Git version and shows **What this install does**: what the app will create
   (planned), the connections it needs, and its settings. Store apps use the latest stable release,
   and the page shows the exact version that was read. To use another version, enter a tag, branch,
   or commit in the **Version** field before pressing Install.
4. If a connection is missing, use **Connect** on that connection's row to create and verify it on
   the same page. The app name and settings can be changed here too; declared defaults are filled in.
5. **Review** shows what the app will create in your cloud (the create, update, replace and delete
   list) and a cost estimate. When the cost can't be estimated, it says so. Nothing is applied until
   you press **Allow and install**; changes that delete or replace something need an extra
   confirmation. Nothing applies automatically, and reloading or opening a URL never grants consent.
   **Stop installing** throws the whole install attempt away, including the unapplied app it created.
   An install you leave without stopping is listed under **Unfinished installs** in the Store, where
   you can continue or stop it; reopening it moves nothing forward. Secret settings are never saved:
   they are sent only when you confirm.
6. When the install finishes, the app's page opens. **Open** starts the app if it has
   an authorized screen. Failures appear under **Needs attention** with the reason and the next step,
   and can be retried with a new review without discarding partially created state.
7. **Uninstall** asks for confirmation before scheduling it. The app and its data remain during the
   grace period, and **Cancel uninstall** brings it back. The confirmation names the other apps that
   use this one. Provider secrets and install inputs are not saved to browser storage.

## Keeping an installed app

Home lists every installed app, including apps without a screen and apps still installing. Each app
shows when it needs attention, has an update, or is installing; apps with a screen can be started
with **Open**. Select an app's name to open its page.

- **Needs attention**: a failed change, a screen that could not be opened, or a scheduled uninstall.
- **Version**: the installed version (tag and commit), a newer version, **Update**, automatic
  updates, going back to a previous version, and choosing a version.
- **Settings**: change its values and the connection it uses for each cloud; connect in place.
- **What it created**: the resources the last applied change created in your cloud, counted per
  cloud, and the cost. An unknown cost is shown as unknown.
- **Linked apps**, **History** (each event opens its reason and logs), and **Uninstall**.

Updating, changing the version, and changing settings all follow the same steps on the page:
**Review** → what will be created and the cost estimate → **Allow and update** / **Allow and apply**.
Nothing applies automatically.

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
