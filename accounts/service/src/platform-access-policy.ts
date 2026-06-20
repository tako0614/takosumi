// Scope: this module gates ONLY the hosted platform readiness surfaces: the
// platform-cell `materialize`/`export` installation mutations and Stripe checkout. The
// generic Takosumi platform (OIDC sign-in, PAT issuance, upstream OAuth,
// passkeys, generic Installations + import, PlanRuns, deployment / rollback
// mutations, and the installation status PATCH) is NOT launch-gated and must
// keep working while the platform readiness is closed.

import { isSha256HexDigest } from "./installation-helpers.ts";
import { json, requestIdFrom } from "./http-helpers.ts";
import type { InstallationRoute } from "./route-matchers.ts";

export interface PlatformAccessPolicy {
  status: "closed" | "open";
  readinessDigest?: string;
  evidenceRef?: string;
  approvalRef?: string;
  publicSummary?: string;
}

export interface PlatformReadinessReportForOpenAccess {
  ready: true;
  evidenceDigest: string;
}

const validatedPlatformReadinessOpenPolicies =
  new WeakSet<PlatformAccessPolicy>();

export function createOpenPlatformAccessPolicy(
  input: {
    evidenceRef?: string;
    approvalRef?: string;
    publicSummary?: string;
  },
  readinessReport: PlatformReadinessReportForOpenAccess,
): PlatformAccessPolicy {
  if (readinessReport.ready !== true) {
    throw new TypeError("platform readiness report must be ready=true");
  }
  const policy: PlatformAccessPolicy = {
    status: "open",
    readinessDigest: readinessReport.evidenceDigest,
    evidenceRef: input.evidenceRef,
    approvalRef: input.approvalRef,
    publicSummary: input.publicSummary,
  };
  if (!platformReadinessOpenPolicyHasSyntacticEvidence(policy)) {
    throw new TypeError(
      "platform readiness open access requires validated digest, distinct evidence/approval refs, and public summary",
    );
  }
  validatedPlatformReadinessOpenPolicies.add(policy);
  return policy;
}

// Returns a 503 launch-readiness response unless the platform readiness is open
// with validated evidence. Call this ONLY from hosted platform readiness call
// sites (materialize/export mutations, Stripe checkout).
export function platformAccessBlocked(
  policy: PlatformAccessPolicy | undefined,
): Response | null {
  if (
    policy?.status === "open" &&
    platformReadinessOpenPolicyHasEvidence(policy)
  ) {
    return null;
  }
  const status = policy?.status ?? "closed";
  return json(
    {
      error: {
        code: "launch_readiness_not_complete",
        message:
          "Hosted platform readiness access is blocked until launch readiness evidence is approved",
        requestId: requestIdFrom(),
      },
      platform_access: status,
    },
    503,
  );
}

function platformReadinessOpenPolicyHasEvidence(
  policy: PlatformAccessPolicy,
): boolean {
  return (
    validatedPlatformReadinessOpenPolicies.has(policy) &&
    platformReadinessOpenPolicyHasSyntacticEvidence(policy)
  );
}

function platformReadinessOpenPolicyHasSyntacticEvidence(
  policy: PlatformAccessPolicy,
): boolean {
  if (policy.status !== "open") return false;
  if (!policy.readinessDigest || !isSha256HexDigest(policy.readinessDigest)) {
    return false;
  }
  const evidenceRef = checkedPlatformReadinessPolicyRef(policy.evidenceRef);
  const approvalRef = checkedPlatformReadinessPolicyRef(policy.approvalRef);
  const publicSummary = policy.publicSummary?.trim();
  if (!evidenceRef || !approvalRef || !publicSummary) return false;
  if (evidenceRef === approvalRef) return false;
  return platformReadinessPublicSummaryAccepted(publicSummary);
}

function checkedPlatformReadinessPolicyRef(
  value: string | undefined,
): string | null {
  const ref = value?.trim();
  if (!ref || platformReadinessTextLooksPlaceholder(ref)) return null;
  return /^[a-z][a-z0-9+.-]*:\/\/.+/i.test(ref) ? ref : null;
}

function platformReadinessPublicSummaryAccepted(summary: string): boolean {
  if (summary.length < 40) return false;
  if (platformReadinessTextLooksPlaceholder(summary)) return false;
  if (!/\bp0\b/i.test(summary) || !/(evidence|証跡)/iu.test(summary)) {
    return false;
  }
  if (!/(staged|rehearsal|リハーサル)/iu.test(summary)) return false;
  return !platformReadinessSummaryLooksSensitive(summary);
}

function platformReadinessTextLooksPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.startsWith("evidence://") ||
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
    normalized.includes(">")
  );
}

function platformReadinessSummaryLooksSensitive(summary: string): boolean {
  return (
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(summary) ||
    /\b(?:cus|sub|in|pi|pm|price|prod|cs|evt|re|cn)_[A-Za-z0-9_]{6,}\b/u.test(
      summary,
    ) ||
    /\bsk_(?:test|live)_[A-Za-z0-9]{6,}\b/u.test(summary) ||
    /\b(?:authorization:\s*)?bearer\s+[A-Za-z0-9._-]{10,}\b/iu.test(summary) ||
    /\barn:aws[a-z-]*:[^\s]+:\d{12}:[^\s]+/iu.test(summary) ||
    /\b\d{12}\b/u.test(summary) ||
    /\b(?:projects|subscriptions|resourceGroups)\/[A-Za-z0-9._:-]{4,}\b/iu.test(
      summary,
    ) ||
    /\b(?:tenant|account|installation|space|resource)[_-]?(?:id)?[:=]\s*[A-Za-z0-9._:-]{6,}\b/iu.test(
      summary,
    ) ||
    /\b(?:acct|inst|tenant|space|run|res)_[A-Za-z0-9._-]{6,}\b/u.test(summary)
  );
}

// Only the platform-cell `materialize`/`export` installation mutations are
// offering surfaces. Generic deployment / deployment-plan-run / rollback
// mutations are part of the non-gated platform and must work while the managed
// offering is closed.
export function platformGuardedInstallationMutation(
  kind: InstallationRoute["kind"],
  method: string,
): boolean {
  if (method === "POST") {
    return kind === "materialize" || kind === "export";
  }
  return false;
}
