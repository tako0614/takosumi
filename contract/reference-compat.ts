// Internal compatibility umbrella for Takosumi reference implementation code.
//
// The Takosumi v1 Deploy Control API contract is owned by the package root
// (`takosumi-contract`) and the focused `deploy-control-api` source-module subpath.
// This file is intentionally not exported from package.json; it exists for
// service-local compatibility imports while legacy implementation modules are
// being retired behind RunnerProfile/OpenTofu execution.
//
// Scope: the re-export list is an explicit allowlist of reference helpers:
// JSON value scalars, condition / reason enums, internal API headers, runtime
// agent contracts. This file deliberately
// avoids re-exporting the retired takosumi-v1 component / descriptor / binding
// surface or reference materializer API as a public umbrella.
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
  ServiceGrant,
  SpaceCreateRequest,
  SpaceSummary,
  SpaceUpdateRequest,
  TrustLevel,
} from "./types.ts";

export {
  assertObjectAddress,
  CORE_CONDITION_REASONS,
  encodeObjectAddressName,
  isCoreConditionReason,
  isObjectAddress,
  joinObjectAddressSegments,
  objectAddress,
  objectAddressSegment,
  type CoreBindingResolutionInput,
  type CoreBindingValueResolution,
  type CoreConditionReason,
  type ObjectAddress,
} from "./takosumi-v1.ts";
export * from "./internal-api.ts";
export * from "./runtime-agent.ts";
export * from "./runtime-agent-lifecycle.ts";
