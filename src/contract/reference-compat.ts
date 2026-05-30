// Reference compatibility umbrella for Takosumi implementation packages.
//
// The Takosumi v1 AppSpec / Installer API contract is owned by the package
// root (`@takos/takosumi-contract`) and the focused `app-spec` /
// `installer-api` subpaths. This umbrella re-exports the larger reference
// implementation API used by kernel, runtime-agent, provider, and connector
// packages while deploy-core compatibility types are being retired.
//
// Scope: the re-export list is an explicit allowlist of legacy reference
// helpers (JSON value scalars, condition / reason enums, deploy-domain
// projections, internal API headers, etc.). Names that collide with the v1
// AppSpec contract or that are entirely unused outside this package are
// intentionally NOT re-exported. In particular, the legacy `AppSpec` /
// `ServiceSpec` / `EnvSpec` / `PolicySpec` / `ApprovalRequirement` /
// `RolloutPolicy` / `ResourceSpec` / `ResourceInstance` /
// `ProviderMaterialization` shapes from `./types.ts` are reachable only via
// `@takos/takosumi-contract/reference/types`, and the legacy `AppSpec`
// interface is exported there as `LegacyReferenceAppSpec`.
//
// New consumers should import directly from `@takos/takosumi-contract`,
// `@takos/takosumi-contract/app-spec`, or
// `@takos/takosumi-contract/installer-api`.

// Selected scalar / DTO surface from ./types.ts (allowlist; no `export *`).
// Names that collide with the v1 AppSpec contract (`AppSpec`, `ServiceSpec`,
// `EnvSpec`, `PolicySpec`, `ApprovalRequirement`, `RolloutPolicy`,
// `ResourceSpec`, `ResourceInstance`, `ProviderMaterialization`,
// `RuntimeNetworkPolicy`) are intentionally NOT re-exported here. They remain
// reachable via the `./reference/types` subpath, where the legacy AppSpec is
// renamed to `LegacyReferenceAppSpec`.
export type {
  ActorContext,
  Condition,
  ConditionStatus,
  Digest,
  DomainEvent,
  GrantEffect,
  GroupCreateRequest,
  GroupSummary,
  GroupSummaryStatus,
  GroupUpdateRequest,
  IsoTimestamp,
  JsonObject,
  JsonPrimitive,
  JsonValue,
  NetworkPeer,
  NetworkRule,
  PrincipalKind,
  ServiceEndpoint,
  ServiceEndpointProtocol,
  ServiceEndpointTrust,
  ServiceGrant,
  SourceSnapshot,
  SpaceCreateRequest,
  SpaceSummary,
  SpaceUpdateRequest,
  TrustLevel,
} from "./types.ts";

export * from "./core-v1.ts";
export * from "./internal-api.ts";
export {
  EnvTakosumiServiceDirectory,
  signTakosumiInternalRequest,
  TAKOSUMI_CORRELATION_ID_HEADER,
  TAKOSUMI_REQUEST_ID_HEADER,
  TAKOSUMI_TRACEPARENT_HEADER,
  TakosumiInternalClient,
  type TakosumiInternalTraceContext,
  type TakosumiInternalTraceSink,
  type TakosumiInternalTraceSpanEvent,
} from "./internal-rpc.ts";
export * from "./plugin.ts";
export * from "./plugin-sdk.ts";
export * from "./runtime-agent.ts";
export * from "./runtime-agent-lifecycle.ts";
export * from "./error-category.ts";
export * from "./shape.ts";
