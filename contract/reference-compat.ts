// Internal reference-runtime umbrella for Takosumi implementation code.
//
// The Takosumi v1 Deploy Control API contract is owned by the package root
// (`takosumi-contract`) and the focused `deploy-control-api` source-module subpath.
// This file is intentionally not exported from package.json; it exists for
// service-local imports used by private runtime and implementation seams.
//
// Scope: the re-export list is an explicit allowlist of reference helpers:
// JSON value scalars, condition / reason enums, internal API headers, runtime
// agent contracts. This file deliberately avoids re-exporting component /
// descriptor / binding surfaces or reference materializer APIs as a public
// umbrella.
//
// New consumers must import directly from `takosumi-contract` or
// `@takosumi/internal/deploy-control-api`.

// Selected scalar / DTO surface from ./types.ts (allowlist; no `export *`).
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
  PrincipalKind,
  ServiceEndpoint,
  ServiceEndpointProtocol,
  ServiceEndpointTrust,
  ReferenceServiceGrant,
  SpaceCreateRequest,
  SpaceSummary,
  SpaceUpdateRequest,
  TrustLevel,
} from "./types.ts";

export {
  assertObjectAddress,
  encodeObjectAddressName,
  isObjectAddress,
  joinObjectAddressSegments,
  objectAddress,
  objectAddressSegment,
  type ObjectAddress,
} from "./object-address.ts";
export {
  CORE_CONDITION_REASONS,
  isCoreConditionReason,
  type CoreConditionReason,
} from "./condition-reasons.ts";
export {
  type CoreBindingResolutionInput,
  type CoreBindingValueResolution,
} from "./binding-resolution.ts";
export * from "./internal-api.ts";
export * from "./runtime-agent.ts";
export * from "./runtime-agent-lifecycle.ts";
