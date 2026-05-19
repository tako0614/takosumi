# Control Plane Architecture

> このページでわかること: current kernel control-plane の責務境界。

Takosumi kernel control plane は AppSpec installer lifecycle を処理し、
Installation / Deployment / runtime dispatch evidence を永続化する。 public
contract は AppSpec (`.takosumi.yml`) / Installation / Deployment の 3 entity と
5 installer endpoint に閉じる。

## Public Contract

```text
POST /v1/installations/dry-run
POST /v1/installations
POST /v1/installations/{id}/deployments/dry-run
POST /v1/installations/{id}/deployments
POST /v1/installations/{id}/rollback
```

auth は `TAKOSUMI_INSTALLER_TOKEN` bearer。

## Owned Responsibilities

- parse / validate `.takosumi.yml`
- create and update Installation records
- record Deployment history and rollback evidence
- resolve component kind / provider decisions through operator registry
- dispatch lifecycle work to runtime-agent
- record audit / WAL / observation evidence
- expose internal ledger reads to operator backplane

## Not Owned

- account / billing / OIDC issuer ownership (Takosumi Accounts)
- workflow runner / webhook / cron execution
- cloud SDK credentials (runtime-agent host)
- app runtime sessions beyond launch-token / OIDC integration boundaries

## Internal Surfaces

operator dashboard / automation uses internal HMAC routes for ledger reads:

```text
GET /api/internal/v1/installations
GET /api/internal/v1/installations/{id}
GET /api/internal/v1/installations/{id}/deployments
GET /api/internal/v1/installations/{id}/events
```

runtime-agent control RPC stays under internal route boundaries and is not part
of the public installer contract.

## Removed Legacy Model

The old raw deploy API, authoring-vs-runtime manifest split, string
interpolation materialization contract, and public Deployment status route are
not current control-plane surfaces. Historical references should be read as
pre-AppSpec notes only.

## Related

- [Installer API](../installer-api.md)
- [Kernel HTTP API](../kernel-http-api.md)
- [Manifest](../manifest.md#data-model)
