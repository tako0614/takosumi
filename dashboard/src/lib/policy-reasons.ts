/**
 * Readable text for a Run's structured policy reasons (TASK-0115 Phase 3a).
 *
 * The control plane projects every reason a policy blocked a plan, or made it
 * wait for an approval, as `{code, layer, provider?, resourceType?}` from a
 * closed set. The dashboard localizes the code and shows the provider or
 * resource type it names. The Run's prose field is never parsed or shown in
 * its place; a code this build does not know falls back to its layer, then to
 * a generic line.
 */
import type { RunPolicyReason } from "./control-api.ts";
import { readableProviderSourceLabel } from "./provider-labels.ts";
import { t, type MessageKey } from "../i18n/index.ts";

const REASON_TEXT: Readonly<Record<string, MessageKey>> = {
  runner_profile_inactive: "policy.reason.runner_profile_inactive",
  runner_profile_unavailable: "policy.reason.runner_profile_unavailable",
  runner_profile_no_executor: "policy.reason.runner_profile_no_executor",
  providers_undeclared: "policy.reason.providers_undeclared",
  provider_denied: "policy.reason.provider_denied",
  provider_not_allowed: "policy.reason.provider_not_allowed",
  resource_type_not_allowed: "policy.reason.resource_type_not_allowed",
  resource_changes_unknown: "policy.reason.resource_changes_unknown",
  resource_out_of_scope: "policy.reason.resource_out_of_scope",
  quota_exceeded: "policy.reason.quota_exceeded",
  quota_invalid: "policy.reason.quota_invalid",
  provider_lockfile_missing: "policy.reason.provider_lockfile_missing",
  provider_attestation_missing: "policy.reason.provider_attestation_missing",
  provider_not_mirrored: "policy.reason.provider_not_mirrored",
  credential_connection_scope: "policy.reason.credential_connection_scope",
  compatibility_report_missing: "policy.reason.compatibility_report_missing",
  compatibility_report_mismatch: "policy.reason.compatibility_report_mismatch",
  compatibility_not_runnable: "policy.reason.compatibility_not_runnable",
  compatibility_finding: "policy.reason.compatibility_finding",
  data_source_not_allowed: "policy.reason.data_source_not_allowed",
  provisioner_not_allowed: "policy.reason.provisioner_not_allowed",
  billing_blocked: "policy.reason.billing_blocked",
  approval_required_change: "policy.reason.approval_required_change",
  approval_required_destroy: "policy.reason.approval_required_destroy",
  unclassified: "policy.reason.unclassified",
};

const LAYER_TEXT: Readonly<Record<string, MessageKey>> = {
  runner_profile: "policy.layer.runner_profile",
  provider: "policy.layer.provider",
  resource: "policy.layer.resource",
  scope: "policy.layer.scope",
  action: "policy.layer.action",
  quota: "policy.layer.quota",
  supply_chain: "policy.layer.supply_chain",
  credential: "policy.layer.credential",
  compatibility: "policy.layer.compatibility",
  billing: "policy.layer.billing",
  unclassified: "policy.layer.unclassified",
};

/** Every reason code this build has its own text for. */
export const KNOWN_POLICY_REASON_CODES: readonly string[] = Object.keys(REASON_TEXT);
/** Every policy layer this build has its own text for. */
export const KNOWN_POLICY_LAYERS: readonly string[] = Object.keys(LAYER_TEXT);

export interface PolicyReasonLine {
  /** The localized sentence for the reason. */
  readonly text: string;
  /** The provider the reason names, as a person reads it. */
  readonly provider?: string;
  /** The OpenTofu resource or data source type the reason names. */
  readonly resourceType?: string;
  /** True when the code was unknown to this build (shown with its layer). */
  readonly fallback: boolean;
}

/** One reason as a line a person can read. */
export function policyReasonLine(reason: RunPolicyReason): PolicyReasonLine {
  const known = Object.hasOwn(REASON_TEXT, reason.code)
    ? REASON_TEXT[reason.code]
    : undefined;
  const layer = Object.hasOwn(LAYER_TEXT, reason.layer)
    ? LAYER_TEXT[reason.layer]
    : undefined;
  const text = known
    ? t(known)
    : layer
      ? t("policy.reason.unknownInLayer", { layer: t(layer) })
      : t("policy.reason.unknown");
  const provider = typeof reason.provider === "string" && reason.provider.trim()
    ? readableProviderSourceLabel(reason.provider.trim())
    : undefined;
  const resourceType = typeof reason.resourceType === "string" && reason.resourceType.trim()
    ? reason.resourceType.trim()
    : undefined;
  return {
    text,
    ...(provider ? { provider } : {}),
    ...(resourceType ? { resourceType } : {}),
    fallback: !known,
  };
}

/** True when a reason only says the change waits for an explicit approval. */
export function isApprovalReason(reason: RunPolicyReason): boolean {
  return reason.code === "approval_required_change" ||
    reason.code === "approval_required_destroy";
}
