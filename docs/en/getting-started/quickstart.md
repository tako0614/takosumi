# Quickstart

Start with a five-minute API check. If you want to continue, bring up the full
local environment with the dashboard, sign-in, database, and OpenTofu runner.

## Five minutes: development API

You need Bun and Git.

```bash
git clone https://github.com/tako0614/takosumi.git
cd takosumi
bun install

TAKOSUMI_DEV_MODE=1 \
TAKOSUMI_DEPLOY_CONTROL_TOKEN=dev-token \
PORT=8788 \
bun core/index.ts
```

Check it from another terminal.

```bash
curl http://127.0.0.1:8788/api/v1/capabilities \
  -H "authorization: Bearer dev-token"
```

The API is running when it returns JSON. This setup stores data in memory, so
it disappears on restart. It also does not start the dashboard or runner. Use
it only for API development.

## About 30 minutes: complete local environment

The remaining steps start a local Takosumi installation on Linux and run a
plan and apply for a Git module. The first run builds containers and the
dashboard.

### Requirements

- Linux. This composition does not support macOS, WSL, or Windows
- Docker and `docker compose`
- Bun, Git, `curl`, and `python3`
- `sudo` for local certificate and DNS setup

### 1. Start the environment

From the repository root:

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

### 2. Configure the local certificate and DNS

```bash
sudo bash scripts/ca-install.sh
sudo bash scripts/configure-dns.sh
```

Run these once per host. Run `ca-install.sh` again if you recreate the local
certificate authority.

### 3. Check the services

```bash
curl https://app.takosumi.test/healthz
curl https://app.takosumi.test/.well-known/openid-configuration
```

When `/healthz` returns `{"ok":true,"database":"ok"}`, the application can reach
Postgres.

### 4. Sign in

Open `https://app.takosumi.test/` and choose **Local OIDC**. It is an identity
provider for local testing and does not require a real account.

### 5. Add the example

While signed in, open:

```text
https://app.takosumi.test/install?git=https://github.com/tako0614/takosumi.git&ref=main&path=examples/opentofu-basic
```

The page opens with the Git URL, ref, and module path filled in. Opening the
link does not create anything. After you check the values and add it, Takosumi
pins the ref to a commit, checks module compatibility, and creates a plan.

The example has no provider and creates no external resource. It lets you test
the runner, plan, apply, and state storage without cloud credentials.

The install action explicitly asks Takosumi to continue a clean plan to apply
when no approval is required. A deletion, approval policy, billing check, or
other gate stops on the Run page. Normal updates, detected drift, and new Git
commits are not applied on their own.

### 6. Inspect the result

Open `https://app.takosumi.test/runs` to see the plan and apply records. The
Capsule page keeps the state produced by each successful apply.

To test the whole environment:

```bash
TAKOSUMI_LOCAL_SUBSTRATE_PROFILE=postgres bash scripts/smoke.sh
```

The final line reports `0 failed` when sign-in, Runs, storage, DNS, and TLS all
work. Logs for failed checks are kept in `/tmp/smoke-logs/`.

### 7. Stop it

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

For the official hosted service, use the
[Takosumi Cloud documentation](https://app.takosumi.com/docs/en/).
