/**
 * Structured projection of a PlanRun's policy decision (core-spec §25).
 *
 * The recorded `PolicyDecision.reasons` are operator-readable prose written by
 * the layer evaluators (runner profile, provider/resource/scope/quota policy,
 * supply-chain checks, compatibility gate, billing). Clients must not parse
 * that prose, so this module maps every reason the evaluators in this build
 * write to one stable {@link RunPolicyReasonCode} and {@link RunPolicyLayer},
 * keeping only the provider source or resource type a reason names. Reasons
 * written by a newer or older build that this table does not recognize stay
 * visible as `unclassified` instead of disappearing.
 *
 * The approval gate is not part of `PolicyDecision.reasons`: it is recorded as
 * `requiresApproval` (action policy) or implied by a destroy plan. Those
 * reasons are derived here from the persisted value-free resource changes with
 * the same predicate the action policy uses.
 *
 * Pure: no store reads. Identifiers that appear in the prose (runner profile,
 * connection, report and run ids, resource addresses) never reach the output.
 */

import type { PlanRun } from "@takosumi/internal/deploy-control-api";
import type { JsonValue } from "takosumi-contract";
import {
  RUN_POLICY_REASON_LIMIT,
  type RunPolicyLayer,
  type RunPolicyReason,
  type RunPolicyReasonCode,
} from "takosumi-contract/runs";
import { resourceTypesRequiringApproval } from "takosumi-policy";

interface ReasonRule {
  readonly pattern: RegExp;
  readonly code: RunPolicyReasonCode;
  readonly layer: RunPolicyLayer;
  /** Which capture group (if any) names a provider or resource type. */
  readonly capture?: "provider" | "resourceType" | "providerList" | "address" | "quotaKey";
}

const TOKEN = String.raw`(\S+)`;

/**
 * Ordered recognizer table. Each entry mirrors one sentence template written
 * by an evaluator; the tests generate the sentences from those evaluators so a
 * wording change fails loudly instead of silently becoming `unclassified`.
 */
const REASON_RULES: readonly ReasonRule[] = [
  // deploy-control/policy.ts — runner profile state and provider lists.
  {
    pattern: /^runner profile \S+ lifecycle is \S+; only active profiles can execute(?::|$)/u,
    code: "runner_profile_inactive",
    layer: "runner_profile",
  },
  {
    pattern: /^runner profile \S+ is unavailable(?::|$)/u,
    code: "runner_profile_unavailable",
    layer: "runner_profile",
  },
  {
    pattern: /^runner profile \S+ has no executorId$/u,
    code: "runner_profile_no_executor",
    layer: "runner_profile",
  },
  {
    pattern: /^runner profile \S+ requires requiredProviders before OpenTofu init$/u,
    code: "providers_undeclared",
    layer: "runner_profile",
  },
  {
    pattern: new RegExp(`^provider ${TOKEN} is denied by runner profile \\S+$`, "u"),
    code: "provider_denied",
    layer: "runner_profile",
    capture: "provider",
  },
  {
    pattern: new RegExp(`^provider ${TOKEN} is not allowed by runner profile \\S+$`, "u"),
    code: "provider_not_allowed",
    layer: "runner_profile",
    capture: "provider",
  },
  // run engine — declared-env credential bindings.
  {
    pattern: /^declared-env provider bindings on runner profile \S+ require requiredProviders before OpenTofu init$/u,
    code: "providers_undeclared",
    layer: "credential",
  },
  {
    pattern: new RegExp(
      `^declared-env provider connection \\S+ for ${TOKEN} must be Workspace-scoped$`,
      "u",
    ),
    code: "credential_connection_scope",
    layer: "credential",
    capture: "provider",
  },
  // takosumi-policy — Workspace/InstallConfig provider allowlist (layer 4).
  {
    pattern: /^requiredProviders must be declared before OpenTofu init$/u,
    code: "providers_undeclared",
    layer: "provider",
  },
  {
    pattern: new RegExp(`^provider ${TOKEN} is denied by policy$`, "u"),
    code: "provider_denied",
    layer: "provider",
    capture: "provider",
  },
  {
    pattern: new RegExp(`^provider ${TOKEN} is not allowed by policy$`, "u"),
    code: "provider_not_allowed",
    layer: "provider",
    capture: "provider",
  },
  // takosumi-policy — resource-type allowlist (layer 5).
  {
    pattern: new RegExp(`^resource type ${TOKEN} is not allowed by policy$`, "u"),
    code: "resource_type_not_allowed",
    layer: "resource",
    capture: "resourceType",
  },
  {
    pattern: /^plan resource changes are unavailable, so the resource policy cannot be evaluated$/u,
    code: "resource_changes_unknown",
    layer: "resource",
  },
  // takosumi-policy — scope boundary (layer 6).
  {
    pattern: new RegExp(`^resource ${TOKEN} .+ is out of scope$`, "u"),
    code: "resource_out_of_scope",
    layer: "scope",
    capture: "address",
  },
  // takosumi-policy — quota (layer 10).
  {
    pattern: new RegExp(`^quota ${TOKEN} limit is invalid is exceeded$`, "u"),
    code: "quota_invalid",
    layer: "quota",
    capture: "quotaKey",
  },
  {
    pattern: new RegExp(`^quota ${TOKEN} count \\d+ exceeds \\d+ is exceeded$`, "u"),
    code: "quota_exceeded",
    layer: "quota",
    capture: "quotaKey",
  },
  // provider_policy.ts — provider supply chain.
  {
    pattern: /^provider lockfile digest is required by policy but was not returned by the runner$/u,
    code: "provider_lockfile_missing",
    layer: "supply_chain",
  },
  {
    pattern: /^provider installation attestation is required by policy but was not returned by the runner$/u,
    code: "provider_attestation_missing",
    layer: "supply_chain",
  },
  {
    pattern: /^provider installation attestation is missing for required providers: (.+)$/u,
    code: "provider_attestation_missing",
    layer: "supply_chain",
    capture: "providerList",
  },
  {
    pattern: /^provider mirror is required by policy but these providers were not attested as installed from the filesystem mirror: (.+)$/u,
    code: "provider_not_mirrored",
    layer: "supply_chain",
    capture: "providerList",
  },
  // run engine / provider_policy.ts — compatibility report gate.
  {
    pattern: /^compatibility_report_missing:/u,
    code: "compatibility_report_missing",
    layer: "compatibility",
  },
  {
    pattern: /^compatibility_report_snapshot_mismatch:/u,
    code: "compatibility_report_mismatch",
    layer: "compatibility",
  },
  {
    pattern: /^compatibility_report_not_runnable:/u,
    code: "compatibility_not_runnable",
    layer: "compatibility",
  },
  {
    pattern: /^capsule_gate_[a-z0-9_]+:/u,
    code: "compatibility_finding",
    layer: "compatibility",
  },
  {
    pattern: new RegExp(
      `^capsule provider ${TOKEN} is not allowed by Workspace/InstallConfig policy$`,
      "u",
    ),
    code: "provider_not_allowed",
    layer: "compatibility",
    capture: "provider",
  },
  {
    pattern: new RegExp(
      `^capsule resource type ${TOKEN} is not allowed by Workspace/InstallConfig policy$`,
      "u",
    ),
    code: "resource_type_not_allowed",
    layer: "compatibility",
    capture: "resourceType",
  },
  {
    pattern: new RegExp(
      `^capsule data source ${TOKEN} is not allowed by Workspace/InstallConfig policy$`,
      "u",
    ),
    code: "data_source_not_allowed",
    layer: "compatibility",
    capture: "resourceType",
  },
  {
    pattern: /^capsule provisioner \S+ is not allowed by Workspace\/InstallConfig policy$/u,
    code: "provisioner_not_allowed",
    layer: "compatibility",
  },
];

/** Provider source addresses and resource types are short, spaceless tokens. */
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._\-/]{0,255}$/u;

function safeToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && SAFE_TOKEN.test(trimmed) ? trimmed : undefined;
}

/**
 * The resource type of an OpenTofu address such as `aws_s3_bucket.logs`,
 * `data.aws_iam_policy.read` or `module.app.aws_s3_bucket.logs["a"]`.
 * Returns `undefined` when the address does not have that shape.
 */
export function resourceTypeFromAddress(address: string): string | undefined {
  const segments: string[] = [];
  let current = "";
  let depth = 0;
  let quoted = false;
  for (const character of address) {
    if (quoted) {
      if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === "[") {
      depth += 1;
      continue;
    }
    if (character === "]") {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth > 0) continue;
    if (character === ".") {
      segments.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  segments.push(current);
  let index = 0;
  while (segments[index] === "module" && index + 1 < segments.length) index += 2;
  if (segments[index] === "data") index += 1;
  // A resource address always ends with `<type>.<name>`.
  if (segments.length - index !== 2) return undefined;
  const type = segments[index];
  return type && /^[a-z][a-z0-9_]*$/u.test(type) ? type : undefined;
}

function quotaResourceType(key: string): string | undefined {
  if (key === "resources" || key === "resources.total") return undefined;
  return /^[a-z][a-z0-9_]*$/u.test(key) ? key : undefined;
}

function classifyReason(
  reason: string,
  billingReasons: ReadonlySet<string>,
): readonly RunPolicyReason[] {
  if (billingReasons.has(reason)) {
    return [{ code: "billing_blocked", layer: "billing" }];
  }
  for (const rule of REASON_RULES) {
    const match = rule.pattern.exec(reason);
    if (!match) continue;
    const base = { code: rule.code, layer: rule.layer } as const;
    const captured = match[1];
    switch (rule.capture) {
      case "provider": {
        const provider = safeToken(captured);
        return [provider ? { ...base, provider } : base];
      }
      case "resourceType": {
        const resourceType = safeToken(captured);
        return [resourceType ? { ...base, resourceType } : base];
      }
      case "address": {
        const resourceType = captured
          ? resourceTypeFromAddress(captured)
          : undefined;
        return [resourceType ? { ...base, resourceType } : base];
      }
      case "quotaKey": {
        const resourceType = captured ? quotaResourceType(captured) : undefined;
        return [resourceType ? { ...base, resourceType } : base];
      }
      case "providerList": {
        const providers = (captured ?? "")
          .split(",")
          .map((entry) => safeToken(entry))
          .filter((entry): entry is string => entry !== undefined);
        return providers.length > 0
          ? providers.map((provider) => ({ ...base, provider }))
          : [base];
      }
      default:
        return [base];
    }
  }
  return [{ code: "unclassified", layer: "unclassified" }];
}

/** Reasons the billing evaluator recorded for this plan, if any. */
function recordedBillingReasons(planRun: PlanRun): ReadonlySet<string> {
  for (let index = planRun.auditEvents.length - 1; index >= 0; index -= 1) {
    const event = planRun.auditEvents[index];
    if (event?.type !== "plan.policy_evaluated") continue;
    const billing: JsonValue | undefined = event.data?.billing;
    if (!billing || typeof billing !== "object" || Array.isArray(billing)) {
      return new Set();
    }
    const reasons = (billing as Readonly<Record<string, JsonValue>>).reasons;
    return new Set(
      Array.isArray(reasons)
        ? reasons.filter((entry): entry is string => typeof entry === "string")
        : [],
    );
  }
  return new Set();
}

function reasonKey(reason: RunPolicyReason): string {
  return [reason.layer, reason.code, reason.provider ?? "", reason.resourceType ?? ""]
    .join("\u0000");
}

/**
 * Structured reasons for a plan a policy blocked or that requires approval.
 * The approval reasons follow the Run projection's `requiresApproval`: every
 * destroy plan, and any plan the action policy gated. Returns `undefined` when
 * the plan passed policy and needs no approval.
 */
export function projectPlanRunPolicyReasons(
  planRun: PlanRun,
): readonly RunPolicyReason[] | undefined {
  const reasons: RunPolicyReason[] = [];
  if (planRun.policy.status === "blocked") {
    const billingReasons = recordedBillingReasons(planRun);
    for (const reason of planRun.policy.reasons) {
      reasons.push(...classifyReason(reason, billingReasons));
    }
    if (reasons.length === 0) {
      reasons.push({ code: "unclassified", layer: "unclassified" });
    }
  }
  const destroyPlan = planRun.operation === "destroy" && planRun.driftCheck !== true;
  if (destroyPlan) {
    reasons.push({ code: "approval_required_destroy", layer: "action" });
  }
  if (planRun.requiresApproval === true && !destroyPlan) {
    const types = resourceTypesRequiringApproval(planRun.planResourceChanges ?? []);
    if (types.length === 0) {
      reasons.push({ code: "approval_required_change", layer: "action" });
    }
    for (const type of types) {
      const resourceType = safeToken(type);
      reasons.push({
        code: "approval_required_change",
        layer: "action",
        ...(resourceType ? { resourceType } : {}),
      });
    }
  }
  if (reasons.length === 0) return undefined;
  const seen = new Set<string>();
  const unique: RunPolicyReason[] = [];
  for (const reason of reasons) {
    const key = reasonKey(reason);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(reason);
    if (unique.length >= RUN_POLICY_REASON_LIMIT) break;
  }
  return unique;
}
