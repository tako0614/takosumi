# Quickstart

Start a local Takosumi installation on a Linux machine, add a sample from the
dashboard, and take it from reviewing the changes (plan) to deploying them
(apply). The sample creates no external resources, so you need no cloud
credentials. The first run builds containers and the dashboard, so it takes a
while.

To check only the API, without the dashboard or runner, follow
[Run only the API](./api-only.md).

## Requirements

- Linux. This composition does not support macOS, WSL, or Windows
- Docker and `docker compose`
- Bun, Git, `curl`, and `python3`
- `sudo` for local certificate and DNS setup

## 1. Get the repository

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install
```

The containers use this checkout and the dependencies installed into it. The
directory they mount is chosen by the name `takosumi` (the `git clone` default).
If you already have a checkout under another name, rename it to `takosumi`
before you continue; otherwise a different `takosumi` directory next to it may
be mounted instead.

## 2. Start the environment

Run this from the repository root.

```bash
cd deploy/local-substrate
bash scripts/up.sh --profile postgres
```

This starts Postgres, object storage, the runner, control plane, dashboard,
local certificate authority, and DNS. On a host where the default AppArmor
profile blocks the containers, use:

```bash
TAKOSUMI_LOCAL_SUBSTRATE_DISABLE_APPARMOR=1 \
bash scripts/up.sh --profile postgres
```

## 3. Configure the local certificate and DNS

Run the remaining commands from `deploy/local-substrate`.

```bash
sudo bash scripts/ca-install.sh
sudo bash scripts/configure-dns.sh
```

Run these once per host. Run `ca-install.sh` again if you recreate the local
certificate authority.

## 4. Check the services

```bash
curl https://app.takosumi.test/healthz
curl https://app.takosumi.test/.well-known/openid-configuration
```

When `/healthz` returns `{"ok":true,"database":"ok"}`, the application can reach
Postgres.

## 5. Sign in

Open `https://app.takosumi.test/` and choose **Local OIDC**. It is an identity
provider for local testing and does not require a real account.

## 6. Add the example

While signed in, open:

```text
https://app.takosumi.test/install?git=https://github.com/tako0614/takosumi.git&ref=main&path=examples/opentofu-basic
```

Adding takes three screens: the prefilled page, **Set up the service**, and
**Review before adding**.

The first page opens with the service name, where the module comes from, and
the steps that follow. The Git URL, ref, and module path are filled in under the
collapsed **Source details**. Opening the link does not create anything. Check
the service name and press **Add**: Takosumi pins the ref to a commit and checks
the module.

[![The first page. The service name takosumi is filled in, with the source github.com/tako0614/takosumi / version main / examples/opentofu-basic, the three steps that follow, and the Add button](/getting-started/quickstart-add-en.png){.screenshot width=1640 height=1578}](/getting-started/quickstart-add-en.png){.light-only}
[![The first page. The service name takosumi is filled in, with the source github.com/tako0614/takosumi / version main / examples/opentofu-basic, the three steps that follow, and the Add button](/getting-started/quickstart-add-en-dark.png){.screenshot width=1640 height=1578}](/getting-started/quickstart-add-en-dark.png){.dark-only}

The example needs no connection and declares two inputs, **Name** and
**Example public URL**, so **Set up the service** comes next with only those two
fields and no connection to choose. Both are optional. Leave them blank and press
**Continue**: the module's defaults apply, and Takosumi prepares the changes
(a plan) before anything is deployed.

[![Set up the service. The optional Name and Example public URL fields are empty, with the Continue button below](/getting-started/quickstart-setup-en.png){.screenshot width=1468 height=532}](/getting-started/quickstart-setup-en.png){.light-only}
[![Set up the service. The optional Name and Example public URL fields are empty, with the Continue button below](/getting-started/quickstart-setup-en-dark.png){.screenshot width=1468 height=532}](/getting-started/quickstart-setup-en-dark.png){.dark-only}

When it is ready, **Review before adding** shows how many resources will be
created, changed, and deleted. The example has no provider and creates no
resources, so all three are 0; it still lets you test the runner, plan, apply,
and state storage without cloud credentials. Nothing has been added yet at this
point. After checking the changes, press **Add** again to start the apply.

[![Review before adding. Create 0, Change 0 and Delete 0 are shown, with the Add button and the Technical details link below](/getting-started/quickstart-review-en.png){.screenshot width=1468 height=626}](/getting-started/quickstart-review-en.png){.light-only}
[![Review before adding. Create 0, Change 0 and Delete 0 are shown, with the Add button and the Technical details link below](/getting-started/quickstart-review-en-dark.png){.screenshot width=1468 height=626}](/getting-started/quickstart-review-en-dark.png){.dark-only}

A change that deletes, replaces, or imports a resource first needs
**Approve this change**, then the **I reviewed these changes** checkbox, before
**Add**; the example's first install shows neither. A change that a policy or
billing check stops shows **Service setup did not finish**, and
**Technical details** opens its Run.

When it finishes, **Service added** appears. The sample has no app screen of
its own, so **Open service** opens the new service's page under **Workloads**.
Normal updates, detected drift, and new Git commits are not applied on their
own.

## 7. Inspect the result

On the service page that **Open service** opened, expand **Update history** on
the **Updates** tab. It lists each apply with its time and marks the version in
use as **Current**. After a later apply, **Restore a previous version** →
**Restore this state** on an older entry creates the changes (a plan) that take
the workload back to that version's source; as in step 6, review them before
they are applied.

[![The Updates tab. Under the tracked version main and the Review changes button, Update history lists the Current version and Version 1 with their times; Restore a previous version on Version 1 is open and shows the Restore this state button (an example after a second apply)](/getting-started/quickstart-updates-en.png){.screenshot width=1704 height=1050}](/getting-started/quickstart-updates-en.png){.light-only}
[![The Updates tab. Under the tracked version main and the Review changes button, Update history lists the Current version and Version 1 with their times; Restore a previous version on Version 1 is open and shows the Restore this state button (an example after a second apply)](/getting-started/quickstart-updates-en-dark.png){.screenshot width=1704 height=1050}](/getting-started/quickstart-updates-en-dark.png){.dark-only}

The plan and apply Runs are listed newest first, as **Review** (plan) and
**Deploy** (apply), under **Deploy history** in the user menu behind your initial
at the top right (`https://app.takosumi.test/runs`).

To test the whole environment:

```bash
TAKOSUMI_LOCAL_SUBSTRATE_PROFILE=postgres bash scripts/smoke.sh
```

The final line reports `0 failed` when sign-in, Runs, storage, DNS, and TLS all
work. Logs for failed checks are kept in `/tmp/smoke-logs/`.

## 8. Stop it

```bash
bash scripts/down.sh
```

Use `bash scripts/down.sh -v` to also remove Postgres data and certificates.

## Next

- [How Takosumi works](../concepts/index.md)
- [Sources and Capsules](../concepts/sources.md)
- [Credentials](../concepts/credentials.md)
- [Self-hosting](../concepts/self-host.md)
- [CLI](../reference/cli.md)

For the official Takosumi hosted service, see the
[hosted service documentation](https://app.takosumi.com/docs/en/).
