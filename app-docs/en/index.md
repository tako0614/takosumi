# Takosumi hosted service

The Takosumi hosted service runs OpenTofu modules from Git and connects them to
the cloud services they need. A Workspace keeps the plan,
apply, state, outputs, audit, usage, and prepaid credit together.

> **Status:** Pre-GA. Code or a catalog entry does not mean a service is
> available. The Dashboard and the authenticated Takosumi catalog expose the
> current `available` state.

## Your first install

1. Sign in to the [dashboard](https://app.takosumi.com/) (switch workspaces only if needed).
2. Choose an app in the **Store**. Git URLs and app install links open the same app page.
3. Check the description and source, then press **Install**. Nothing is created in your cloud yet.
   Stay on this app page throughout. **About this app** shows its repository and pinned version;
   open **Version** to choose a tag, branch or commit, and **Configuration** to change connections, the app name or optional settings.
   Missing required inputs, missing connections and invalid answers open their fields automatically.
4. If a connection is missing, use **Connect** on that connection's row to create and verify it on the same screen.
   A connection with only one candidate, declared setting defaults, and the configuration named by the Store (or the only available configuration) are chosen automatically.
   Choose a configuration only when the repository has no unambiguous selection.
5. Once nothing is missing, Takosumi says **Checking what will be created** and shows a cost estimate (or says when the cost can't be estimated).
   This check creates nothing in your cloud. Open **Resource details** to see what will be created; details open automatically for changes to existing resources or deletions.
   **Install** is shown from the start; until it can be pressed, the reason is shown beside it (for example "Choose a connection to check it", "Fill in the required settings", "Checking…").
   Nothing is applied until you press **Install** (changes that delete or replace something need an extra confirmation). Nothing applies automatically, and reloading or opening a URL never grants consent.
6. When the install finishes, the same screen offers **Open** (when the app has an authorized screen)
   and **Manage app** (the app's own page). Failures show the reason and the next step, and can be
   retried with a new review without discarding partially created state.
7. **Uninstall** asks for confirmation before scheduling it. The app and its data remain during the
   grace period, and **Cancel uninstall** brings it back. The confirmation names the other apps that
   use this one.

### Changing inputs, resuming, or canceling

- **Versions and input timing**: An unspecified Store version displays **Latest** and resolves the latest stable release when you start. Reopening a saved attempt shows its saved version; it does not automatically switch to a newer release. Typed settings, the name and the version count once you leave the field (or press Enter); while you type, checking and allowing wait.
- **Re-planning after edits**: Changing the name, version, a connection or a setting after the check marks the shown result out of date (it can no longer be allowed) and checks again with your change, saying **Preparing the install again with your change**.
- **Stopping an install**: **Stop installing** throws the whole install attempt away, including the unapplied app it created.
- **Resuming later**: An install you leave without stopping is listed under **Unfinished installs** in the Store, where you can continue or stop it; reopening it moves nothing forward until you press **Continue**. An install started without this screen that stopped before creating its app is listed there as **Can't be continued here**, and can only be stopped.
- **Secret handling**: Secret settings are never saved: they are sent only to check what will be created. Provider secrets and install inputs are not saved to browser storage.

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

## Takoform and Takoserver

[Takoform](https://takoform.com/) owns the portable Form specification, Host API, and OpenTofu provider.
[Takoserver](https://takoserver.com/) is an independent, self-hostable cloud control plane and Takoform Host.
The Takosumi hosted service intends to provide official Takoform Host integration, but the current Host
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
