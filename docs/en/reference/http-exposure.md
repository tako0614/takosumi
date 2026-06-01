# HTTP Exposure {#http-exposure}

Takosumi v1 does not describe HTTP exposure with a Takosumi-specific source DSL.
Public endpoints, custom domains, TLS, routes, and runtime targets are
PlatformServices exposed by the operator catalog and materialized by the
operator-selected runtime or gateway implementation.

## Install-Time Model

```text
Source
  -> Installer API dry-run
  -> operator catalog resolves HTTP / runtime PlatformServices
  -> InstallPlan shows planned outputs and binding selections
  -> apply records bindingsSnapshot and outputs on the Deployment
```

Takosumi core guarantees the Deployment record. The data plane that receives
HTTP requests, host assignment, TLS certificates, DNS ownership proof, and
backend route objects are managed by the operator distribution.

## Runtime Request Path

```text
client
  -> operator-managed listener / route / gateway
  -> active runtime target selected by the current Deployment
  <- response
```

Traffic authority is the Installation current Deployment pointer. Rollback
moves that pointer back to a retained `succeeded` Deployment. Takosumi core does
not resolve the Source again during rollback.

## Public Output

Deployment `outputs` contain only non-secret endpoint metadata the operator has
chosen to publish. Secrets, provider object ids, certificate private keys, and
DNS verification tokens stay in operator evidence or secret storage.

## Related Pages

- [Core Specification](./core-spec.md)
- [Installer API](./installer-api.md)
- [Platform Services](./platform-services.md)
