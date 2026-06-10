/**
 * takosumi-policy: layered plan-policy evaluators (core-spec.md §25 "Policy").
 *
 * Pure functions over plan data. The package hosts the per-layer evaluators the
 * deploy-control plane composes when a PlanRun completes and the runner has
 * returned its provider/resource projection:
 *
 *   - {@link evaluateProviderAllowlist} — §25 layer 4 (provider allowlist). The
 *     RunnerProfile policy engine (`deploy-control/policy.ts`) is a thin adapter
 *     over this evaluator.
 *   - {@link evaluateResourceAllowlist} — §25 layer 5 (resource-type allowlist).
 *     The template plan-JSON policy (`deploy-control/template_policy.ts`) uses it.
 *   - {@link evaluateActionPolicy} — §25 layer 7 (action policy): create/update
 *     allowed; any delete/replace requires approval.
 *   - {@link evaluateScopeBoundary} — §25 layer 6 (scope boundary): validates
 *     sanitized provider scope metadata when configured.
 *   - {@link evaluateQuotaPolicy} — §25 layer 10 (quota): mutating resource
 *     count ceilings.
 *   - {@link composePolicyVerdict} — folds the layer results into a single
 *     {@link PolicyVerdict} (pass / warn / deny + requiresApproval + reasons).
 *
 * The package is deliberately free of service / contract-store imports: it
 * operates on plain plan data (required providers, resource-change lines,
 * allowlists) so both the RunnerProfile engine and the controller's post-runner
 * evaluation can reuse it without pulling in any service dependency.
 *
 */

/**
 * One resource change line projected from `tofu show -json tfplan`
 * (`resource_changes`). Mirrors the contract `PlanResourceChange` shape so the
 * package stays contract-free: `actions` mirrors the OpenTofu change actions,
 * e.g. `["create"]`, `["delete"]`, `["delete","create"]` (replace), `["no-op"]`.
 */
export interface PlanResourceChange {
  readonly address: string;
  readonly type: string;
  readonly actions: readonly string[];
  readonly scope?: {
    readonly cloudflareAccountId?: string;
    readonly cloudflareZoneId?: string;
    readonly awsAccountId?: string;
    readonly awsRegion?: string;
  };
}

const NON_MUTATING_ACTIONS = new Set(["no-op", "read"]);

// ---------------------------------------------------------------------------
// §25 layer 4 — provider allowlist
// ---------------------------------------------------------------------------

export interface ProviderAllowlistInput {
  /** Allowed provider rules (fully-qualified address or trailing short type). */
  readonly allowed: readonly string[];
  /** Denied provider rules; a denial overrides an allow. */
  readonly denied?: readonly string[];
  /**
   * Whether a run with zero required providers is intentional (skips the
   * "requiredProviders before OpenTofu init" gate). Set for a §10 provider-free
   * install — a template whose policy declares zero allowed providers, e.g.
   * `core`, which is pure value plumbing with no cloud resources. A raw cloud
   * run still must declare providers (the gate's original purpose).
   */
  readonly allowNoProviders?: boolean;
}

export interface ProviderAllowlistResult {
  /** Providers denied by an explicit denylist rule. */
  readonly denied: readonly string[];
  /** Providers not admitted by any allowlist rule (and not denied). */
  readonly notAllowed: readonly string[];
  /**
   * True when the run declares zero providers, the profile constrains providers,
   * and `allowNoProviders` was not set (the "providers before init" gate).
   */
  readonly missingProviders: boolean;
  /** Reasons describing the violations (never includes secret values). */
  readonly reasons: readonly string[];
}

/**
 * Evaluates the provider allowlist for a plan's required/observed providers
 * (§25 layer 4). A denial overrides an allow; a provider admitted by neither
 * the allow- nor deny-list is `notAllowed`. When the profile constrains
 * providers but the run declares none, the "providers before init" gate trips
 * unless `allowNoProviders` is set. Pure; no profile / store state.
 */
export function evaluateProviderAllowlist(
  required: readonly string[],
  input: ProviderAllowlistInput,
): ProviderAllowlistResult {
  const denied: string[] = [];
  const notAllowed: string[] = [];
  const reasons: string[] = [];
  const deniedRules = input.denied ?? [];
  const missingProviders = input.allowed.length > 0 &&
    required.length === 0 &&
    input.allowNoProviders !== true;
  if (missingProviders) {
    reasons.push("requiredProviders must be declared before OpenTofu init");
  }
  for (const provider of required) {
    if (providerDenied(provider, deniedRules)) {
      denied.push(provider);
      reasons.push(`provider ${provider} is denied by policy`);
      continue;
    }
    if (!providerAllowed(provider, input.allowed)) {
      notAllowed.push(provider);
      reasons.push(`provider ${provider} is not allowed by policy`);
    }
  }
  return { denied, notAllowed, missingProviders, reasons };
}

// ---------------------------------------------------------------------------
// §25 layer 5 — resource-type allowlist
// ---------------------------------------------------------------------------

export interface ResourceAllowlistResult {
  /** Mutating resource types observed in the plan NOT in the allowlist. */
  readonly disallowedResourceTypes: readonly string[];
  /** Reasons describing the violations (never includes secret values). */
  readonly reasons: readonly string[];
}

/**
 * Evaluates the resource-type allowlist for the plan's mutating changes (§25
 * layer 5). A change that only no-ops/reads neither mutates nor needs
 * allowlisting. An `undefined` allowlist means "not configured" — no resource
 * type is enforced (the layer is skipped). An empty `[]` allowlist enforces
 * that NO mutating resource type is permitted. Pure; no store state.
 */
export function evaluateResourceAllowlist(
  changes: readonly PlanResourceChange[],
  allowedResourceTypes: readonly string[] | undefined,
): ResourceAllowlistResult {
  if (allowedResourceTypes === undefined) {
    return { disallowedResourceTypes: [], reasons: [] };
  }
  const allowed = new Set(allowedResourceTypes);
  const disallowed = new Set<string>();
  for (const change of changes) {
    if (!isMutating(change.actions)) continue;
    if (!allowed.has(change.type)) disallowed.add(change.type);
  }
  const disallowedResourceTypes = Array.from(disallowed).sort();
  const reasons = disallowedResourceTypes.map(
    (type) => `resource type ${type} is not allowed by policy`,
  );
  return { disallowedResourceTypes, reasons };
}

// ---------------------------------------------------------------------------
// §25 layer 7 — action policy
// ---------------------------------------------------------------------------

export interface ActionPolicyResult {
  /**
   * True when any change deletes or replaces a resource (its `actions` contain
   * `"delete"`). create / update are allowed without approval.
   */
  readonly requiresApproval: boolean;
  /** Reasons describing why approval is required (never includes values). */
  readonly reasons: readonly string[];
}

// ---------------------------------------------------------------------------
// §25 layer 6 — scope boundary
// ---------------------------------------------------------------------------

export interface ScopeBoundaryPolicy {
  /**
   * `strict` fails closed when a resource belongs to a configured provider
   * family but the plan projection lacks the configured scope metadata.
   */
  readonly mode?: "permissive" | "strict";
  readonly cloudflare?: {
    readonly accountIds?: readonly string[];
    readonly zoneIds?: readonly string[];
  };
  readonly aws?: {
    readonly accountIds?: readonly string[];
    readonly regions?: readonly string[];
  };
}

export interface ScopeBoundaryResult {
  readonly outOfScope: readonly string[];
  readonly reasons: readonly string[];
}

export function evaluateScopeBoundary(
  changes: readonly PlanResourceChange[],
  policy: ScopeBoundaryPolicy | undefined,
): ScopeBoundaryResult {
  if (policy === undefined) return { outOfScope: [], reasons: [] };
  const strict = policy.mode === "strict";
  const violations = new Set<string>();
  for (const change of changes) {
    if (!isMutating(change.actions)) continue;
    if (change.type.startsWith("cloudflare_") && policy.cloudflare) {
      evaluateScopedValue({
        change,
        configuredValues: policy.cloudflare.accountIds,
        observedValue: change.scope?.cloudflareAccountId,
        strict,
        label: "Cloudflare account",
        violations,
      });
      evaluateScopedValue({
        change,
        configuredValues: policy.cloudflare.zoneIds,
        observedValue: change.scope?.cloudflareZoneId,
        strict,
        label: "Cloudflare zone",
        violations,
      });
    }
    if (isAwsResource(change.type) && policy.aws) {
      evaluateScopedValue({
        change,
        configuredValues: policy.aws.accountIds,
        observedValue: change.scope?.awsAccountId,
        strict,
        label: "AWS account",
        violations,
      });
      evaluateScopedValue({
        change,
        configuredValues: policy.aws.regions,
        observedValue: change.scope?.awsRegion,
        strict,
        label: "AWS region",
        violations,
      });
    }
  }
  const outOfScope = Array.from(violations).sort();
  return {
    outOfScope,
    reasons: outOfScope.map((entry) => `resource ${entry} is out of scope`),
  };
}

// ---------------------------------------------------------------------------
// §25 layer 10 — quota
// ---------------------------------------------------------------------------

export interface QuotaResult {
  readonly exceeded: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * Enforces simple mutating resource-count quotas. Supported keys:
 * - `resources` / `resources.total`: total mutating resource changes.
 * - `<resource_type>`: mutating changes for a specific OpenTofu resource type.
 */
export function evaluateQuotaPolicy(
  changes: readonly PlanResourceChange[],
  quota: Readonly<Record<string, number>> | undefined,
): QuotaResult {
  if (quota === undefined) return { exceeded: [], reasons: [] };
  const mutating = changes.filter((change) => isMutating(change.actions));
  const counts = new Map<string, number>([
    ["resources", mutating.length],
    ["resources.total", mutating.length],
  ]);
  for (const change of mutating) {
    counts.set(change.type, (counts.get(change.type) ?? 0) + 1);
  }
  const exceeded: string[] = [];
  for (const [key, limit] of Object.entries(quota)) {
    if (!Number.isFinite(limit) || limit < 0) {
      exceeded.push(`${key} limit is invalid`);
      continue;
    }
    const count = counts.get(key) ?? 0;
    if (count > limit) exceeded.push(`${key} count ${count} exceeds ${limit}`);
  }
  exceeded.sort();
  return {
    exceeded,
    reasons: exceeded.map((entry) => `quota ${entry} is exceeded`),
  };
}

/**
 * Evaluates the §25 action policy over the plan's changes: create allowed,
 * update allowed, any delete or replace (`actions` containing `"delete"`,
 * which OpenTofu also uses for a replace `["delete","create"]`) requires
 * approval. Pure; no store state.
 */
export function evaluateActionPolicy(
  changes: readonly PlanResourceChange[],
): ActionPolicyResult {
  const destructiveTypes = new Set<string>();
  for (const change of changes) {
    if (change.actions.includes("delete")) destructiveTypes.add(change.type);
  }
  const requiresApproval = destructiveTypes.size > 0;
  const reasons = requiresApproval
    ? Array.from(destructiveTypes).sort().map(
      (type) => `resource type ${type} has a delete/replace change requiring approval`,
    )
    : [];
  return { requiresApproval, reasons };
}

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

export type PolicyStatus = "pass" | "warn" | "deny";

export interface PolicyVerdict {
  readonly status: PolicyStatus;
  /**
   * Whether an explicit approval is required before apply may proceed. Set by
   * the action policy (delete/replace) and, when composed in, the destroy flow.
   */
  readonly requiresApproval: boolean;
  /** Aggregated reasons across the composed layers (never includes values). */
  readonly reasons: readonly string[];
}

/**
 * Scope-boundary inputs (§25 layer 6). A non-empty `outOfScope` list denies.
 */
export interface ScopeBoundaryInput {
  readonly outOfScope?: readonly string[];
  readonly reasons?: readonly string[];
}

/**
 * Quota inputs (§25 layer 10). A non-empty `exceeded` list denies.
 */
export interface QuotaInput {
  readonly exceeded?: readonly string[];
  readonly reasons?: readonly string[];
}

export interface ComposePolicyVerdictInput {
  /** §25 layer 4 — provider allowlist result. */
  readonly provider?: ProviderAllowlistResult;
  /** §25 layer 5 — resource-type allowlist result. */
  readonly resource?: ResourceAllowlistResult;
  /** §25 layer 7 — action policy result. */
  readonly action?: ActionPolicyResult;
  /**
   * Destroy flow (§25 action policy `destroy: destroy flow`): a destroy plan
   * always requires approval, independent of its resource changes.
   */
  readonly destroy?: boolean;
  /**
   * §25 layer 6 — scope boundary.
   */
  readonly scope?: ScopeBoundaryInput;
  /**
   * §25 layer 10 — quota.
   */
  readonly quota?: QuotaInput;
}

/**
 * Folds the layer results into a single {@link PolicyVerdict} (§25). A provider
 * denial / not-allowed, a missing-provider gate trip, or a disallowed resource
 * type DENIES the plan (it cannot apply). A delete/replace action or a destroy
 * flow requires approval but does not deny (the plan succeeds, parked awaiting
 * approval). `warn` is reserved for future advisory layers; the MVP layers emit
 * only `pass` / `deny`.
 *
 */
export function composePolicyVerdict(
  input: ComposePolicyVerdictInput,
): PolicyVerdict {
  const reasons: string[] = [];
  let deny = false;
  if (input.provider) {
    reasons.push(...input.provider.reasons);
    if (
      input.provider.missingProviders ||
      input.provider.denied.length > 0 ||
      input.provider.notAllowed.length > 0
    ) {
      deny = true;
    }
  }
  if (input.resource) {
    reasons.push(...input.resource.reasons);
    if (input.resource.disallowedResourceTypes.length > 0) deny = true;
  }
  if (input.scope?.outOfScope && input.scope.outOfScope.length > 0) {
    deny = true;
    reasons.push(...(input.scope.reasons ??
      input.scope.outOfScope.map((r) => `resource ${r} is out of scope`)));
  }
  if (input.quota?.exceeded && input.quota.exceeded.length > 0) {
    deny = true;
    reasons.push(...(input.quota.reasons ??
      input.quota.exceeded.map((r) => `quota ${r} is exceeded`)));
  }
  const requiresApproval = (input.action?.requiresApproval ?? false) ||
    (input.destroy ?? false);
  if (input.action) reasons.push(...input.action.reasons);
  return {
    status: deny ? "deny" : "pass",
    requiresApproval,
    reasons,
  };
}

// ---------------------------------------------------------------------------
// internals
// ---------------------------------------------------------------------------

function isMutating(actions: readonly string[]): boolean {
  return actions.some((action) => !NON_MUTATING_ACTIONS.has(action));
}

function evaluateScopedValue(input: {
  readonly change: PlanResourceChange;
  readonly configuredValues: readonly string[] | undefined;
  readonly observedValue: string | undefined;
  readonly strict: boolean;
  readonly label: string;
  readonly violations: Set<string>;
}): void {
  if (input.configuredValues === undefined) return;
  if (!input.observedValue) {
    if (input.strict) {
      input.violations.add(
        `${input.change.address} missing ${input.label} metadata`,
      );
    }
    return;
  }
  if (!input.configuredValues.includes(input.observedValue)) {
    input.violations.add(
      `${input.change.address} ${input.label} ${input.observedValue}`,
    );
  }
}

function isAwsResource(type: string): boolean {
  return type.startsWith("aws_");
}

function providerAllowed(
  provider: string,
  allowedProviders: readonly string[],
): boolean {
  return allowedProviders.some((allowed) =>
    allowed === "*" || providerMatches(provider, allowed)
  );
}

function providerDenied(
  provider: string,
  deniedProviders: readonly string[],
): boolean {
  return deniedProviders.some((denied) => providerMatches(provider, denied));
}

/**
 * Hierarchical, one-directional provider match: a fully-qualified provider
 * address (`registry/namespace/type`) matches a short allowlist rule (its
 * trailing type), e.g. `registry.opentofu.org/cloudflare/cloudflare` matches
 * rule `cloudflare`. The reverse must NOT hold — a specific fully-qualified
 * RULE must not admit an ambiguous bare provider name (e.g. rule
 * `registry.opentofu.org/hashicorp/aws` must not match provider `aws`), which
 * would silently widen the allowlist (and inconsistently narrow the denylist).
 */
export function providerMatches(provider: string, rule: string): boolean {
  return provider === rule || provider.endsWith(`/${rule}`);
}
