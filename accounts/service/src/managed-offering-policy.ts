// Scope: this module gates ONLY the managed-takos offering surfaces — the
// hosted-signup funnel (`/v1/installations/use-takos/start`), the managed-cell
// `materialize`/`export` installation mutations, and Stripe checkout. The
// generic Takosumi platform (OIDC sign-in, PAT issuance, upstream OAuth,
// passkeys, generic Installations + import, PlanRuns, deployment / rollback
// mutations, and the installation status PATCH) is NOT launch-gated and must
// keep working while the managed offering is closed.

import { isSha256HexDigest } from "./installation-helpers.ts";
import { json, requestIdFrom } from "./http-helpers.ts";
import type { InstallationRoute } from "./route-matchers.ts";

export interface ManagedOfferingAccessPolicy {
  status: "closed" | "open";
  readinessDigest?: string;
  evidenceRef?: string;
  approvalRef?: string;
  publicSummary?: string;
}

export interface ManagedOfferingReadinessReportForOpenAccess {
  ready: true;
  evidenceDigest: string;
}

const validatedManagedOfferingOpenPolicies = new WeakSet<
  ManagedOfferingAccessPolicy
>();

export function createOpenManagedOfferingAccessPolicy(
  input: {
    evidenceRef?: string;
    approvalRef?: string;
    publicSummary?: string;
  },
  readinessReport: ManagedOfferingReadinessReportForOpenAccess,
): ManagedOfferingAccessPolicy {
  if (readinessReport.ready !== true) {
    throw new TypeError("managed offering readiness report must be ready=true");
  }
  const policy: ManagedOfferingAccessPolicy = {
    status: "open",
    readinessDigest: readinessReport.evidenceDigest,
    evidenceRef: input.evidenceRef,
    approvalRef: input.approvalRef,
    publicSummary: input.publicSummary,
  };
  if (!managedOfferingOpenPolicyHasSyntacticEvidence(policy)) {
    throw new TypeError(
      "managed offering open access requires validated digest, distinct evidence/approval refs, and public summary",
    );
  }
  validatedManagedOfferingOpenPolicies.add(policy);
  return policy;
}

// Returns a 503 launch-readiness response unless the managed offering is open
// with validated evidence. Call this ONLY from managed-takos offering call
// sites (use-takos/start, materialize/export mutations, Stripe checkout). The
// offering-gate semantics here are unchanged; only the set of call sites that
// invoke it has been narrowed to offering surfaces.
export function managedOfferingAccessBlocked(
  policy: ManagedOfferingAccessPolicy | undefined,
): Response | null {
  if (
    policy?.status === "open" && managedOfferingOpenPolicyHasEvidence(policy)
  ) {
    return null;
  }
  const status = policy?.status ?? "closed";
  return json({
    error: {
      code: "launch_readiness_not_complete",
      message:
        "Public managed Takos signup, install, and paid access are blocked until launch readiness evidence is approved",
      requestId: requestIdFrom(),
    },
    managed_offering_access: status,
  }, 503);
}

function managedOfferingOpenPolicyHasEvidence(
  policy: ManagedOfferingAccessPolicy,
): boolean {
  return validatedManagedOfferingOpenPolicies.has(policy) &&
    managedOfferingOpenPolicyHasSyntacticEvidence(policy);
}

function managedOfferingOpenPolicyHasSyntacticEvidence(
  policy: ManagedOfferingAccessPolicy,
): boolean {
  if (policy.status !== "open") return false;
  if (!policy.readinessDigest || !isSha256HexDigest(policy.readinessDigest)) {
    return false;
  }
  const evidenceRef = checkedManagedOfferingPolicyRef(policy.evidenceRef);
  const approvalRef = checkedManagedOfferingPolicyRef(policy.approvalRef);
  const publicSummary = policy.publicSummary?.trim();
  if (!evidenceRef || !approvalRef || !publicSummary) return false;
  if (evidenceRef === approvalRef) return false;
  return managedOfferingPublicSummaryAccepted(publicSummary);
}

function checkedManagedOfferingPolicyRef(
  value: string | undefined,
): string | null {
  const ref = value?.trim();
  if (!ref || managedOfferingTextLooksPlaceholder(ref)) return null;
  return /^[a-z][a-z0-9+.-]*:\/\/.+/i.test(ref) ? ref : null;
}

function managedOfferingPublicSummaryAccepted(summary: string): boolean {
  if (summary.length < 40) return false;
  if (managedOfferingTextLooksPlaceholder(summary)) return false;
  if (!/\bp0\b/i.test(summary) || !/(evidence|証跡)/iu.test(summary)) {
    return false;
  }
  if (!/(staged|rehearsal|リハーサル)/iu.test(summary)) return false;
  return !managedOfferingSummaryLooksSensitive(summary);
}

function managedOfferingTextLooksPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("evidence://") ||
    normalized.includes("todo") ||
    normalized.includes("tbd") ||
    normalized.includes("dummy") ||
    normalized.includes("fake") ||
    normalized.includes("changeme") ||
    normalized.includes("placeholder") ||
    normalized.includes("example.com") ||
    normalized.includes("example.test") ||
    normalized.includes("example.invalid") ||
    normalized.includes("<") ||
    normalized.includes(">");
}

function managedOfferingSummaryLooksSensitive(summary: string): boolean {
  return /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(summary) ||
    /\b(?:cus|sub|in|pi|pm|price|prod|cs|evt|re|cn)_[A-Za-z0-9_]{6,}\b/u
      .test(summary) ||
    /\bsk_(?:test|live)_[A-Za-z0-9]{6,}\b/u.test(summary) ||
    /\b(?:authorization:\s*)?bearer\s+[A-Za-z0-9._-]{10,}\b/iu.test(summary) ||
    /\barn:aws[a-z-]*:[^\s]+:\d{12}:[^\s]+/iu.test(summary) ||
    /\b\d{12}\b/u.test(summary) ||
    /\b(?:projects|subscriptions|resourceGroups)\/[A-Za-z0-9._:-]{4,}\b/iu
      .test(summary) ||
    /\b(?:tenant|account|installation|space|resource)[_-]?(?:id)?[:=]\s*[A-Za-z0-9._:-]{6,}\b/iu
      .test(summary) ||
    /\b(?:acct|inst|tenant|space|run|res)_[A-Za-z0-9._-]{6,}\b/u.test(
      summary,
    );
}

// Only the managed-cell `materialize`/`export` installation mutations are
// offering surfaces. Generic deployment / deployment-plan-run / rollback
// mutations are part of the non-gated platform and must work while the managed
// offering is closed.
export function managedOfferingGuardedInstallationMutation(
  kind: InstallationRoute["kind"],
  method: string,
): boolean {
  if (method === "POST") {
    return kind === "materialize" ||
      kind === "export";
  }
  return false;
}
