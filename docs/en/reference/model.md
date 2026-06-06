# Model

Takosumi v1 is a run ledger around plain OpenTofu module repositories.

```text
OpenTofu module repo
  -> PlanRun
  -> ApplyRun
  -> Deployment
  -> DeploymentOutput
```

## Installation

An Installation is a Space-scoped installed module record. It stores source identity, runner profile, status, and current Deployment pointer.

Sources are `git`, `prepared`, or `local`. `local` is for dev / operator-local profiles and is accepted only when the RunnerProfile explicitly sets `sourcePolicy.allowLocalSource: true`.

## PlanRun

A PlanRun records source digest, variables digest, runner-observed required providers, policy decision, policy decision digest, immutable plan artifact metadata, plan digest, provider lock digest, diagnostics, audit events, and for update / destroy the Installation current Deployment pointer observed at plan time.

`planArtifact.digest` must equal `planDigest`; in the reference runner this is the digest of the binary `tfplan` file. The Cloudflare reference profile stores the reviewed `tfplan` under the `opentofu-plan-runs/` prefix in the `R2_ARTIFACTS` R2 bucket and records an `object-storage` artifact ref on the PlanRun. ApplyRun restores that immutable artifact into the runner and applies it directly, so apply does not re-plan from source after review.

## ApplyRun

An ApplyRun is created from a PlanRun. Its `expected` guard must match the reviewed PlanRun digests. The record stores state backend reference, lock evidence, runner profile, diagnostics, and audit events.

For update / destroy, apply is also rejected if the Installation current Deployment pointer changed after the PlanRun was created. Accounts / dashboard facades do not fill missing guard fields from the PlanRun. Callers carry the complete expected guard from the PlanRun response or facade review response to apply.

## Deployment

A Deployment is a successful ApplyRun result.

## DeploymentOutput

DeploymentOutput records are derived from `tofu output -json`. Secret outputs are not stored as public ledger values.

## RunnerProfile

RunnerProfile owns provider allowlists, credential references, state backend, execution substrate, resource limits, network policy, Cloudflare Container execution, Cloudflare Workers for Platforms dispatch runtime, and secret exposure policy.

In the Cloudflare topology, the OpenTofu runner is a Container and tenant / user Worker ingress is Workers for Platforms. Provider credentials, Deploy Control tokens, and state backend credentials are not passed into tenant / user Workers.
