# Browser test playbook (claude-in-chrome)

Manually reproducible end-to-end test of the local-substrate's user-facing flows from the host's Chrome via the claude-in-chrome MCP. CI automation is out of scope for the current plan; this playbook is the audit trail.

## Prerequisites

```bash
cd takosumi/deploy/local-substrate
bash scripts/up.sh --profile postgres
# Or use the Worker-first mirror where service.takosumi.test is the Takosumi
# service Worker on D1/R2/Queue/DO:
# bash scripts/up.sh --profile workers
sudo bash scripts/ca-install.sh         # trust Pebble issuance root
sudo bash scripts/configure-dns.sh      # *.takosumi.test → 127.0.0.1
```

After `ca-install.sh` Chrome trusts the Pebble-issued certs (no green-lock warning). After `configure-dns.sh` the host resolves `app.takosumi.test`, `service.takosumi.test`, `app.takosumi.test`, etc. via CoreDNS.

## Smoke flow A — accounts OIDC discovery

1. Navigate: `https://app.takosumi.test/.well-known/openid-configuration`
2. Expect: 200 with valid OIDC config JSON, `issuer` = `https://app.takosumi.test`
3. Verify cert chain: chrome:lock → certificate → root = `Pebble Root CA`

## Smoke flow B — service admin probe

1. Navigate: `https://service.takosumi.test/health`
2. Expect with `--profile postgres`: 200 with `{"ok":true,"service":"takosumi","domains":["space","deploy"]}`
3. Expect with `--profile workers`: 200 from the Takosumi service Worker routed through Cloudflare Worker bindings

## Smoke flow C — Takosumi service Worker probe

1. Navigate with `--profile postgres`: `https://service-worker.takosumi.test/healthz`
2. Navigate with `--profile workers`: `https://service.takosumi.test/healthz`
3. Expect: 200 with `{"ok":true,"provider":"cloudflare-worker"}`
4. Navigate with the same host: `/storage/healthz`
5. Expect: 200 with `{"ok":true,"storage":"cloudflare-d1-r2"}`
6. Navigate with the same host: `/coordination/healthz`
7. Expect: 200 with `{"ok":true,"role":"coordination"}`

## Smoke flow D — Takosumi upstream OAuth

1. Navigate: `https://app.takosumi.test/sign-in`
2. Expect: redirect to `https://oauth-mock.test/{google|github}/authorize?...` when a provider is selected.
3. Complete the local mock backend flow.
4. Expect: redirect back to `https://app.takosumi.test/sign-in/callback?code=...`
5. Expect: the dashboard session is established.

## Smoke flow E — deploy control API

1. Run the deploy control smoke:
   ```bash
   bash scripts/cli-smoke.sh
   ```
2. Expect: runner profile lookup, PlanRun, ApplyRun, Installation read, and Deployment list all succeed through the deploy control API.

Dynamic `<id>.app.takosumi.test` projection is deferred. Takosumi v1's public deploy control API does not expose raw desired-route listings; route projection must come from a future operator-internal source.

## Failure flow F — public-deploy route closure

1. Run:
   ```bash
   bash scripts/prove-no-public-leak.sh
   ```
2. Expect: closed public deployment routes return 404, CoreDNS denies public ACME DNS lookups, and emulator containers do not publish host ports.

## Notes

- The `--cacert` flag is needed only for `curl` from inside the local-substrate dir — Chrome uses the system trust store after `ca-install.sh`.
- If Pebble is restarted (down -v then up.sh) the issuance root regenerates and `ca-install.sh` must be re-run — host trust is invalidated otherwise.
