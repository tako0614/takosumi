// Deploy domain types — slimmed down to the Deployment-centric shape.
//
// The `Deployment` record (and its nested types) is canonical and lives in
// `takosumi-contract`. Anything kept here is a deploy-domain-local helper
// for: (1) the public `.takos/app.yml` manifest authoring surface, and
// (2) status-narrowed views over `Deployment` used inside the deploy-domain
// process pipeline.

import type {
  Deployment,
  DeploymentStatus,
  IsoTimestamp,
  JsonObject,
} from "takosumi-contract";

export type {
  Deployment,
  DeploymentApproval,
  DeploymentBinding,
  DeploymentCondition,
  DeploymentDesired,
  DeploymentInput,
  DeploymentPolicyDecision,
  DeploymentResolution,
  DeploymentResourceClaim,
  DeploymentRoute,
  DeploymentRuntimeNetworkPolicy,
  DeploymentStatus,
  GroupHead,
  ProviderObservation,
} from "takosumi-contract";

// Public manifest authoring surface (`.takos/app.yml`). All shapes are open
// (index-signature) because manifest fields are validated downstream by the
// compiler/normalizer, not by these types.

export type DeploySourceKind = "manifest" | "git_ref" | "package";
export type DeployPhase = "plan" | "apply";

export interface DeploySourceRef {
  kind: DeploySourceKind;
  uri?: string;
  repositoryUrl?: string;
  ref?: string;
  commitSha?: string;
  packageName?: string;
  packageVersion?: string;
}

export interface PublicComputeSpec extends Record<string, unknown> {
  type?: string;
  image?: string;
  port?: number;
  env?: Record<string, string>;
  depends?: string[];
  consume?: Array<JsonObject>;
  requirements?: { runtimeCapabilities?: string[]; minInstances?: number };
}

export type PublicConsumeSpec = JsonObject & {
  /**
   * Legacy authoring alias. New manifests SHOULD use `output` (and may
   * additionally express the binding under component-level `bindings:`).
   */
  publication?: string;
  /** Canonical authoring keyword for selecting an Output as a binding source. */
  output?: string;
  resource?: string;
  secret?: string;
  inject?: JsonObject;
  access?: JsonObject | string;
  as?: string;
};

export interface PublicComputeRequirements {
  runtimeCapabilities?: string[];
  minInstances?: number;
  [key: string]: unknown;
}

export interface PublicResourceSpec extends Record<string, unknown> {
  type: string;
  plan?: string;
  env?: Record<string, string>;
}

export interface PublicRouteSpec extends Record<string, unknown> {
  id?: string;
  target?: string;
  host?: string;
  path?: string;
  protocol?: string;
  port?: number;
  methods?: string[];
  source?: string;
}

export interface PublicPublishSpec extends Record<string, unknown> {
  name?: string;
  type: string;
  from?: string;
  outputs?: JsonObject;
  spec?: JsonObject;
}

export interface PublicDeployManifest extends Record<string, unknown> {
  name: string;
  version?: string;
  compute?: Record<string, PublicComputeSpec>;
  resources?: Record<string, PublicResourceSpec>;
  routes?: Record<string, PublicRouteSpec> | PublicRouteSpec[];
  /**
   * App-level Output declarations. New manifests SHOULD prefer `outputs`;
   * `publications` is retained as a legacy alias and is folded into the
   * canonical `outputs` map during expansion.
   */
  outputs?: Record<string, PublicPublishSpec> | PublicPublishSpec[];
  publications?: Record<string, PublicPublishSpec> | PublicPublishSpec[];
  env?: Record<string, string>;
  overrides?: JsonObject;
}

export interface AppSpecComponent {
  name: string;
  type: string;
  image?: string;
  port?: number;
  entrypoint?: string;
  command?: string[];
  args?: string[];
  env: Record<string, string>;
  depends: string[];
  consume: PublicConsumeSpec[];
  requirements?: PublicComputeRequirements;
  raw: PublicComputeSpec;
}

export interface AppSpecResource {
  name: string;
  type: string;
  env: Record<string, string>;
  raw: PublicResourceSpec;
}

export interface AppSpecRoute {
  name: string;
  to: string;
  host?: string;
  path?: string;
  protocol: string;
  /** Listener port for protocols that route by port instead of HTTP path. */
  port?: number;
  /** Runtime target port on the destination component. */
  targetPort?: number;
  methods?: string[];
  source?: string;
  interfaceContractRef?: string;
  raw: PublicRouteSpec;
}

export interface AppSpecPublication {
  name: string;
  type: string;
  from?: string;
  outputs: JsonObject;
  spec: JsonObject;
  raw: PublicPublishSpec;
}

export interface AppSpec {
  groupId: string;
  name: string;
  version?: string;
  source: DeploySourceRef;
  components: AppSpecComponent[];
  resources: AppSpecResource[];
  routes: AppSpecRoute[];
  publications: AppSpecPublication[];
  env: Record<string, string>;
  overrides: JsonObject;
  /**
   * C2 — Composite expansion / profile merge result. Each entry maps a
   * component name to the union of `requirements.runtimeCapabilities` from
   * the authoring manifest plus capabilities contributed by the composite
   * resolver and provider-profile selection. The descriptor-closure builder
   * folds this map into the closure digest so a profile switch that injects
   * different capabilities produces a different digest even when the raw
   * manifest text is identical (Core spec § 6 — closure determinism).
   *
   * Empty / omitted means "no extra capabilities beyond what the component
   * already declared". Always sorted (stable digest input).
   */
  readonly effectiveRuntimeCapabilities?: Readonly<
    Record<string, readonly string[]>
  >;
  /**
   * Composite expansion descriptor aliases pinned by the closure builder.
   * Mirrors the existing private optional field; surfaced here so other
   * tooling (resolved_graph, descriptor_closure) can read it without a cast.
   */
  readonly authoringExpansionDescriptors?: readonly string[];
}

// Status-narrowed views over a Deployment. Compile-time helpers; no new fields.

export interface ResolvedDeployment extends Deployment {
  status: Extract<DeploymentStatus, "resolved">;
  applied_at: null;
  finalized_at: null;
}

export interface AppliedDeployment extends Deployment {
  status: Extract<DeploymentStatus, "applied" | "rolled-back">;
  applied_at: IsoTimestamp;
}

export interface FailedDeployment extends Deployment {
  status: Extract<DeploymentStatus, "failed">;
}

// Authoring blockers surfaced during resolution. These are also folded into
// `Deployment.conditions[]` once the Deployment is persisted.

export type DeployBlockerSource =
  | "conformance"
  | "registry-trust"
  | "provider-support"
  | "migration"
  | "approval"
  | "external";

export interface DeployBlocker {
  readonly source: DeployBlockerSource;
  readonly code: string;
  readonly message: string;
  readonly subject?: string;
  readonly observedAt?: IsoTimestamp;
  readonly metadata?: JsonObject;
}

export type DeployPhaseBlockerSource = DeployBlockerSource | "read-set";

export interface DeployPhaseBlocker {
  readonly phase: DeployPhase;
  readonly source: DeployPhaseBlockerSource;
  readonly code: string;
  readonly message: string;
  readonly subject?: string;
  readonly observedAt?: IsoTimestamp;
  readonly metadata?: JsonObject;
}

export interface RetainedDeployArtifact {
  readonly id: string;
  readonly kind:
    | "app-release"
    | "router-config"
    | "runtime-network-policy"
    | "descriptor-closure"
    | "resolved-graph";
  readonly digest: string;
  readonly retainedAt: IsoTimestamp;
  readonly retainedUntil?: IsoTimestamp;
  readonly sourceActivationId?: string;
}
