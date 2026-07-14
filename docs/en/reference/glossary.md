# Glossary

One-line explanations of the words used across the Takosumi docs.
See the [Model reference](./model.md) for details.

## Words used in the UI

Normal screens do not expose the internal model directly; they use these words instead.

| UI word | Internal term | Meaning |
| --- | --- | --- |
| Service / App | Capsule | An app, worker, API, site, storage, etc. that you host |
| Connection | ProviderConnection / ProviderBinding | An account link to Cloudflare / AWS / GCP and others |
| Changes | plan (Run) | The list of changes you review before applying |
| History | Run records / AuditEvent | Who changed what, and when |
| Restore point | StateVersion | A saved state you can go back to |

## Core words

| Term | Meaning |
| --- | --- |
| Takosumi | Software that deploys and manages OpenTofu/Terraform modules from Git through a plan → review → apply flow. |
| OpenTofu | An open-source tool (Terraform-compatible) for defining infrastructure as code. Takosumi is the side that runs it. |
| Workspace | The boundary for a user or team. Projects, connections, secrets, and history are isolated inside it. |
| Project | One product, service, or infrastructure group inside a Workspace. |
| Capsule | One OpenTofu/Terraform module execution unit, usually sourced from a Git URL + ref + path. |
| Source | Where a Capsule comes from: Git URL / branch / commit / directory. |
| Run | The record of one execution. Operations such as plan / apply / destroy are stored with logs, results, and the actor. |
| plan / apply / destroy | plan computes and shows what will change, apply makes the change, destroy removes resources. Each is recorded as a Run. |
| StateVersion | The state version saved on every apply. Usable as a restore point. |
| Output | An ordinary root-module return value captured via `tofu output -json`. It may feed another Capsule's OpenTofu input or an explicit Interface input mapping. |
| Interface | A versioned, non-secret declaration of a deployed runtime. Service-side configuration explicitly maps any required public Output name. |
| InterfaceBinding | Runtime authorization that gives a Principal, ServiceAccount, Capsule, or Resource permissions and a credential-delivery method. |
| Secret | An encrypted stored value. Write-only through the API and redacted from logs. |
| Runner | The isolated execution environment (sandbox) that actually runs OpenTofu. |
| AuditEvent | The audit record of who did what to which target. |
| Operator | The organization or person running Takosumi for themselves or their own users. |

## Connection and credential words

| Term | Meaning |
| --- | --- |
| ProviderConnection | Safely stored credentials for a provider such as Cloudflare or AWS. Passed as env vars or files only while a Run executes. |
| CredentialRecipe | The definition of env vars, files, and pre-run actions needed to run that provider. |
| ProviderBinding | The mapping "this provider in this Capsule uses this connection". Unbound providers are never silently filled in; they stop safely. |

## Resource Shape words

These only appear when you use `takosumi_*` resources. If you only run plain OpenTofu modules, you can skip them.

| Term | Meaning |
| --- | --- |
| Resource Shape | An implementation-independent resource type, like "I want one object storage". |
| Target / TargetPool | Where a Shape resolves to: the operator-enabled candidates and their pools. |
| Policy | The rules for which Shape may resolve where. |
| Adapter | The implementation that turns a Shape into a real resource. |
| ResolutionLock | The record that pins a resolved Shape → Target mapping. |
| NativeResource | The record of the real resource created by a resolution. |
| Space / Environment / Stack | The namespace, environment (dev/prod, etc.), and grouping units for Shapes. |
| Compatibility API | A compatibility API with an explicit scope and version, like `compat.s3.v1`. Not full AWS or Cloudflare compatibility. |
