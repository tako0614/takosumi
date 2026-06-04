# Deploy topology notes

> このページでわかること: Takos デプロイのサービスセット構成と topology
> の注意点。

## Service-set alignment done here

- Takos product の service set は `takos-app` / `takos-git` / `takos-agent`。
- `takos-app` は public Web/API gateway。browser と API client は `takos-app`
  から入り、owning internal service が呼ばれる。
- operator がデプロイするのは単一 Cloudflare worker (= Takosumi platform worker、
  `app.takosumi.com`) のみ。 Takos product worker はユーザーが自分のインフラに
  self-host するもので、operator は deploy しない。
- platform worker は Takosumi の accounts plane
  (`deploy/accounts-cloudflare/src/handler.ts`) と deploy-control
  (`deploy/cloudflare/src/handler.ts`) を **in-process** で mount する。 別 worker
  / 別サブドメイン (`accounts.takosumi.com` / `deploy-control.takosumi.com`) は
  持たない。
- `/internal/*` HTTP は opentofu-runner / executor container callback 専用。
- local-substrate dev stack も同じ単一 worker 構成を local-substrate hostname で
  mirror する。

worker が束ねる surface:

- account plane: bare-origin OIDC issuer / Installation 参照 / billing
- deploy control: PlanRun / ApplyRun / Installation ledger (`/v1/installations/*`)
- Accounts D1 / Installation export 用 R2、OpenTofu runner 用 Container / queue

これらの D1 / R2 / Container / queue binding と secret は、 operator が
[`./platform-worker-deploy.md`](./platform-worker-deploy.md) の手順
(`takosumi/deploy/platform/`) で platform worker を deploy する際に配線して
materialize する。

## Current Guard

operator-facing docs / private deploy artifacts do not model the single worker
as a multi-service workload topology. The current service keys are:

- `takosApp`
- `takosGit`
- `takosAgent`

Dashboard queries, port-forward snippets, and operator TODOs should select by
`takos.io/service-id` rather than by process role, and removed workload names
such as `control-web`, `control-dispatch`, `runtime-host`, or `executor-host`
must not reappear.
