# Glossary

Short explanations of the words used across the Takosumi docs, one term at a
time. How each thing behaves is described in the [API](./api.md) and
[CLI](./cli.md) references.

## Words on screen and words inside

The dashboard does not put internal terms in front of you. When the API or these
docs use a different name, read it back through this table.

| Word on screen | Internal term | What it refers to |
| --- | --- | --- |
| Service / App | Capsule | One deployed unit. |
| Connected accounts | ProviderConnection / ProviderBinding | Stored credentials, and where they are assigned. |
| Changes | plan | The list of changes you review before anything is applied. |
| Change verification ID | planDigest | The value that proves the plan you reviewed is the plan being applied. |
| Update history | The list of Runs | What ran, and when. |
| History | Activity / AuditEvent | Who did what, and when. |
| Restore this state | Restoring from a StateVersion | Choosing an earlier state again. |

## The overall frame

| Term | Meaning |
| --- | --- |
| Takosumi | A control plane that runs OpenTofu / Terraform modules kept in Git through plan, review, and apply, and keeps the history. |
| OpenTofu | An open-source tool that defines infrastructure as code and applies it. Compatible with Terraform. |
| Workspace | The boundary that groups people and resources. Members, permissions, connections, and history are separated by it. |
| Project | A division used to organize the inside of a Workspace. |
| Source | A registration of which repository, which directory, and which ref to follow. |
| SourceSnapshot | The commit a Source resolved its ref to. This is always what gets executed. |
| Capsule | One deployed unit. It runs a single OpenTofu root module. |
| stale | The state of a Capsule whose tracked Source has a newer commit. |
| Stack flow | The path that runs a module you wrote yourself from Git. |
| Compatibility report | The result of analyzing a registered module read-only, showing the variables and providers it needs. |
| Dependency | A relation that connects Capsules so one can read another's Output. Across Workspaces it goes through an OutputShare. |
| InstallConfig | The settings Takosumi keeps for how a Capsule runs, such as variable mapping and which Outputs are published. |
| App Handoff | The URL convention that sends a user from an outside app into the creation screen. |
| Store | The listing used to find and browse services you can add. |

## Running and recording

| Term | Meaning |
| --- | --- |
| Run | The record of one execution. plan and apply are separate Runs, and an apply Run is pinned to the plan Run you reviewed. |
| plan | The operation that computes and shows what will change. Nothing real changes yet. |
| apply | The operation that applies the plan you reviewed, unchanged. |
| destroy | The operation that removes the resources a Capsule created. A plan is produced first, then applied. |
| refresh | The operation that re-reads state and Outputs into Takosumi without touching anything real outside. |
| drift check | The read-only operation that looks for gaps between saved state and reality. |
| drift | The gap that has appeared between saved state and reality. |
| RunGroup | The record grouping several Runs in dependency order. It is created by a Workspace-wide update or drift check, and by adding, updating, or destroying a Capsule. |
| Runner | The isolated execution environment that actually runs OpenTofu. Credentials are handed over only inside it. |
| StateVersion | The state at the moment an apply finished. These accumulate rather than overwrite. |
| Output | A non-secret value a Capsule publishes outward. |
| OutputShare | The record that passes an Output across Workspaces. The receiving side approves it before it takes effect. |
| AuditEvent | A record, one per entry, of who acted on what, how, and with what result. |
| ledger | The store that Run and Resource records accumulate in. The entry point differs, but the destination is the same. |

## Credentials

| Term | Meaning |
| --- | --- |
| Connection | Credentials saved write-only. There is no path to read them back after creation. |
| ProviderConnection | The name for a Connection that is handed to an OpenTofu provider. |
| ProviderBinding | The mapping that says this provider in this Capsule uses this connection. |
| CredentialRecipe | A setup aid that collects the environment-variable names and file names each provider needs. |
| Secret | A secret value stored encrypted. |
| secret partition | The token naming the encryption partition a secret is stored in. You give it when creating a Connection. |
| personal access token | An API token issued by Accounts. It carries `read` / `write` / `admin` scopes. |

## Runtime connections

| Term | Meaning |
| --- | --- |
| Interface | The declaration of what something you deployed provides. |
| InterfaceBinding | The authorization for who may use that Interface, and with which permissions. |
| Principal | The subject on the consuming side that is a person or an account. |
| ServiceAccount | The subject on the consuming side that is not a person. |
| permission | A token for an operation a Binding allows. You request this range when taking a token. |
| Interface token | A short-lived token minted per request in order to call an Interface. Its prefix is `taksrv_`. |

## Typed services

These words appear on the path that creates a service by declaring a type only.

| Term | Meaning |
| --- | --- |
| Resource | A typed service you can create by declaration alone, without writing a module. |
| Resource Shape | The name the current API, provider, and state use for a Resource's type. Also written simply as shape. |
| Service Form | A service type defined separately from any implementation. Resource Shape is its current name. |
| FormRef | The identifier that points to exactly one Service Form definition. It is made of the type name, the version, and the digest of the definition. |
| Form Package | A bundle holding only the definition schema and its accompanying information. |
| Form Registry | The list of Form Packages an endpoint trusts and has pinned. |
| FormActivation | The record in which an operator decides which Form is exposed to whom. |
| Space | The namespace of the Resource API. On requests through the platform it must match the Workspace id. |
| Target | Where a Resource is actually created. |
| TargetPool | The set of candidate Targets an operator has enabled. |
| SpacePolicy | The rules for which Resource may resolve where. |
| Resolver | The mechanism that picks the implementation and the placement from a declared Resource. |
| Adapter | The part that turns a chosen implementation into a real resource. It handles preview, apply, import, observe, refresh, and delete. |
| ResolutionLock | The record that pins an implementation and placement once decided. |
| NativeResource | The record of the provider-side resource an Adapter actually created. |
| observe | A read-only drift check against a Resource. |
| import | The operation that takes an existing real resource into Takosumi's records. |
| portability | How movable a chosen resolution is. The values are `portable` / `mostly_portable` / `partial` / `locked_in`. |
| Compatibility API | An entry point that accepts a standard protocol such as S3 or OCI within a decided scope and version. |

## Reading status

| Term | Meaning |
| --- | --- |
| phase | The observed stage. A Resource ranges from `Pending` through `Ready` or `Failed`. |
| Ready | A word for a usable state. It is a phase value on Resource and InterfaceBinding, and one of the Condition types. |
| Condition | A record that keeps the evidence for a state, one entry at a time. It holds a type, `true` / `false` / `unknown`, and a reason. |
| generation | The version number of the desired state. It advances each time the declaration changes. |
| observedGeneration | The number showing which generation the status was written against. |

## Words that cut across

| Term | Meaning |
| --- | --- |
| capability | A token for what is enabled on an endpoint. Read this rather than an edition name. |
| profile | A named bundle of settings with a decided scope. Examples are `compat.s3.v1` on the compatibility API, and the `profiles` an EdgeWorker asks of its runtime. |
| surface | A group of entry points usable from outside. `/api/v1` and `/v1` are separate surfaces. |
| digest | A SHA-256 fingerprint computed from content. The same content always gives the same value. |
| fail closed | Stopping rather than letting something through when the decision is unclear. |
| lease | A mechanism that reserves ownership with an expiry so the same target is not processed in two places at once. |
| CAS (compare-and-swap) | Checking just before an update that the version you read is still current, and not writing if it changed. |
| cursor | An opaque token for reading the next part of a list. Do not interpret it; pass it straight into the next request. |

Which capabilities are enabled on an endpoint is answered by the endpoint itself.

```bash
curl -s https://takosumi.example.com/.well-known/takosumi
```

## Who operates it

| Term | Meaning |
| --- | --- |
| Operator | The party running Takosumi for themselves or for their own users. |
| Takosumi Cloud | The hosted service run officially. |
| showback | The billing mode that goes as far as recording and showing usage. |
| ServiceOffering | The record defining a service Cloud provides, down to price and capacity. |
