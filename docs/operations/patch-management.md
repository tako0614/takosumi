# Operations: Patch Management

> このページでわかること: Takosumi platform worker、dashboard、runner
> container、Bun/npm dependencies、operator reference template の patch
> management 方針。

この runbook は **Takosumi operated environment** の patch management 正本です。
operator が production / staging で deploy するのは単一 Cloudflare Worker
(Takosumi platform worker) です。Takos product worker や bundled apps の
patch gate はそれぞれの product docs が所有します。

## Scope

| Area                            | Owner                                                      | Patch path                                                            |
| ------------------------------- | ---------------------------------------------------------- | --------------------------------------------------------------------- |
| Platform worker source          | `takosumi/worker` / `takosumi/core`                        | Takosumi service checks + platform deploy                             |
| Dashboard SPA                   | `takosumi/dashboard`                                       | dashboard typecheck / build                                           |
| Runner image                    | `takosumi/runner/Dockerfile`                               | image rebuild + Cloudflare Container smoke                            |
| CredentialRecipe / provider policy packs | `takosumi/docs/core-spec.md`, schema/store/policy packages | CredentialRecipe/provider allowlist tests + custom provider policy evidence |
| Custom runner policy            | `takosumi/runner`, operator boundary policy                | custom runner smoke + egress policy evidence                          |
| Provider mirror/cache policy    | runner tofu CLI config / provider mirror                   | provider install attestation tests                                    |
| OpenTofu modules                | `takosumi/opentofu-modules`                                | module tests / fixture plan where available                           |
| Bun/npm dependencies            | each Takosumi package root                                 | `bun outdated`, `bun update`, checks                                  |
| Operator realized config        | `takosumi-private/platform/wrangler.toml`                  | private repo review; no secrets committed                             |

private deploy credentials and rotation evidence live outside public repos in
the operator vault / approved run log. Public docs may mention secret classes
and commands, but never secret values, provider account ids, or raw object keys.

## Base Image Rules

- Runner Dockerfile must not use `latest` or floating major-only tags.
- Language/runtime images should be pinned to a patch or digest where practical.
- Distro suite tags are allowed only with scheduled rebuild and vulnerability scan evidence.
- Production container references in realized config should be digest-pinned after promotion.
- Package installs must avoid unnecessary packages (`--no-install-recommends` or equivalent).

## Weekly Patch Window

Default window:

- Tuesday 13:00-15:00 JST: dependency / image update review and staging deploy
- Wednesday 13:00-15:00 JST: production promotion if staging is green

Emergency window:

- exploited critical CVE
- suspected secret exposure
- internet-facing remote code execution path
- provider-mandated patch or deprecation deadline

During emergency patch work, unrelated platform worker deploys are frozen.

## Required Checks

Before staging promotion:

```bash
cd takosumi
bun run check
bun test
cd dashboard && bun run build
```

`bun run check` is the package-level gate: it includes the root typecheck,
worker typecheck, and Cloudflare worker build checks. Do not replace it with a
raw `tsc --noEmit`-only check for release or patch promotion.

When docs or public contract changed:

```bash
cd takosumi
bun run docs:build
cd ..
bun run check:architecture
bun run check:architecture:strict
bun run check:design-docs
bun run check:legacy-names
```

When runner image changed, add a Cloudflare Container smoke in staging using
the deployed `OpenTofuRunnerObject`, not only local Docker.

## Severity SLA

| Severity                                 | Target      | Required action                                           |
| ---------------------------------------- | ----------- | --------------------------------------------------------- |
| Critical exploited / internet-facing RCE | 24h         | emergency patch, staging proof, production promotion      |
| Critical not known exploited             | 72h         | patch PR, rebuild affected artifact, production promotion |
| High                                     | 7 days      | normal patch window                                       |
| Medium                                   | 30 days     | next dependency refresh                                   |
| Low                                      | best effort | batch with routine updates                                |

If the affected package is not present in the runtime path or is unreachable,
record a time-boxed exception with owner and expiry.

## Promotion Checklist

- dependency / image update PR is merged
- affected artifact is rebuilt
- tests / typecheck / dashboard build are green
- runner smoke is green when runner changed
- staging platform worker is healthy for one observation window
- rollback worker version / commit / image digest is known
- private deploy log records operator, timestamp, command, and smoke result

## Evidence

public evidence:

- PR link
- CI / local gate summary
- release gate summary

private evidence:

- provider account id
- secret rotation log
- production deploy operator log
- Cloudflare worker version id and runner image digest
