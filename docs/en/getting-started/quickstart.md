# Quickstart

Bring up one Takosumi on a Linux machine you already have, then take one OpenTofu
module from Git all the way from plan to apply. The first run builds Docker images,
so allow about 30 minutes. After that, startup takes a few minutes.

When you are done, you have:

- a Takosumi you can sign in to at `https://app.takosumi.test`, with the sign-in
  issuer, the control plane, the dashboard, and the runner that executes OpenTofu
  all on the same origin
- one [Capsule](../reference/glossary.md) — a deployed unit — created from a Git URL,
  with the plan and the apply both recorded
- a path you can repeat against your own repository by swapping the Git URL

## Prerequisites

- Linux. DNS goes through systemd-resolved and containers through the Docker
  daemon, so macOS, WSL, and Windows do not work
- Docker and `docker compose`
- Bun
- Git
- `curl` and `python3`, used by the startup checks and by the verification script
  in step 7
- sudo, to install the certificate and DNS settings on the host once

## 1. Get the repository

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install
```

Keep the directory named `takosumi`. The compose files used in the next step refer to
the repository by that name.

## 2. Start the local Takosumi

```bash
cd deploy/local-substrate
bash scripts/up.sh --profile postgres
```

This brings everything up on a single Docker network: Pebble as the local
certificate authority, CoreDNS for name resolution, Caddy for TLS termination,
Postgres, MinIO for object storage, the runner container that executes OpenTofu,
the control plane, and the dashboard. The first run builds the images and the
dashboard here. When startup finishes, the commands to run next and the URLs to
check are printed on screen.

On some hosts Docker cannot start containers under its default AppArmor profile.
There, set an environment variable:

```bash
TAKOSUMI_LOCAL_SUBSTRATE_DISABLE_APPARMOR=1 bash scripts/up.sh --profile postgres
```

## 3. Install the certificate and DNS on the host

```bash
sudo bash scripts/ca-install.sh
sudo bash scripts/configure-dns.sh
```

`ca-install.sh` installs the root certificate Pebble issued into the system trust
store and into the Chrome and Firefox certificate databases. `configure-dns.sh`
points `*.takosumi.test` queries at CoreDNS. Both are once per host. Restarting
Pebble rotates the root certificate, so run `ca-install.sh` again when that
happens.

## 4. Check that it is up

```bash
curl https://hello.takosumi.test/
curl https://app.takosumi.test/healthz
curl https://app.takosumi.test/.well-known/openid-configuration
```

When `/healthz` returns `{"ok":true,"database":"ok"}`, the control plane reaches
Postgres. When `/.well-known/openid-configuration` answers, the issuer that accepts
sign-in is up.

## 5. Sign in

Open `https://app.takosumi.test/` in a browser. The sign-in screen offers
"Local OIDC" — choose it. It is the verification identity provider bundled with
this stack, so no real account is needed.

## 6. Apply one module

While signed in, open this URL:

```text
https://app.takosumi.test/install?git=https://github.com/tako0614/takosumi.git&ref=main&path=examples/opentofu-basic
```

`/install` fills the Git URL, the ref, and the module path into the `/new` form and
stops there. Opening the link creates nothing. The screen shows the source, the
version, and the folder; read them, then press "Add service".

After that press, Takosumi carries on. It resolves the ref to a commit and pins it,
reads the module and checks compatibility, creates the Capsule, and creates a plan.
When the plan succeeds and nothing requires approval and nothing is scheduled for
deletion, it goes straight through to apply. When the Capsule is configured to
require approval, or the plan contains a deletion, the Run screen shows the plan and
stops so you read it and deploy yourself.

`examples/opentofu-basic` declares no provider and creates no external resource.
It takes you through plan, apply, and state recording without a single cloud
credential.

## 7. Confirm it worked

Open `https://app.takosumi.test/runs` and you see the plan Run and the apply Run you
just created. When both finished successfully, the module you keep in Git was
applied through this Takosumi. On the Capsule detail screen, the state at the end of
each apply (a StateVersion) accumulates one per apply.

To check the whole stack at once, run the bundled verification script. Tell it which
profile you brought up; without the variable it runs as the `workers` profile and
fails looking for containers that are not running.

```bash
TAKOSUMI_LOCAL_SUBSTRATE_PROFILE=postgres bash scripts/smoke.sh
```

The last line reading `==> <count> passed, 0 failed` means success: sign-in, plan and
apply, reads of the Run records, object storage, DNS, and TLS all work. Logs for
failed checks stay in `/tmp/smoke-logs/`.

## 8. Tear down

```bash
bash scripts/down.sh
```

To also drop the Postgres contents and the issued certificates, run
`bash scripts/down.sh -v`.

## Where to go next

- [Overview](../concepts/index.md) — how Source, Run, state, and outputs connect
- [Sources and Capsules](../concepts/sources.md) — register your own repository
- [Credentials](../concepts/credentials.md) — hand provider credentials over
- [CLI](../reference/cli.md) — automate what you did on screen

For the official hosted service, see the
[Takosumi Cloud docs](https://app.takosumi.com/docs/en/).
