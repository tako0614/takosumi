/**
 * Structured policy reasons (TASK-0115 Phase 3a): every code and layer the
 * contract defines has its own text in both languages, the provider and
 * resource type a reason names are shown, an unknown code falls back to its
 * layer, and the Run's prose field is never read.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RUN_POLICY_LAYERS, RUN_POLICY_REASON_CODES } from "../../../../contract/runs.ts";
import {
  isApprovalReason,
  KNOWN_POLICY_LAYERS,
  KNOWN_POLICY_REASON_CODES,
  policyReasonLine,
} from "../../../../dashboard/src/lib/policy-reasons.ts";
import type { RunPolicyReason } from "../../../../dashboard/src/lib/control-api.ts";
import { en } from "../../../../dashboard/src/i18n/en.ts";
import { ja } from "../../../../dashboard/src/i18n/ja.ts";
import { setLocale, t } from "../../../../dashboard/src/i18n/index.ts";

const root = resolve(import.meta.dir, "../../../../dashboard/src");

describe("policy reason text", () => {
  test("every contract code and layer has its own text, in Japanese and English", () => {
    expect([...KNOWN_POLICY_REASON_CODES].sort()).toEqual([...RUN_POLICY_REASON_CODES].sort());
    expect([...KNOWN_POLICY_LAYERS].sort()).toEqual([...RUN_POLICY_LAYERS].sort());
    for (const code of RUN_POLICY_REASON_CODES) {
      const key = `policy.reason.${code}` as keyof typeof ja;
      expect({ code, ja: Boolean(ja[key]), en: Boolean(en[key]) }).toEqual({ code, ja: true, en: true });
    }
    for (const layer of RUN_POLICY_LAYERS) {
      const key = `policy.layer.${layer}` as keyof typeof ja;
      expect({ layer, ja: Boolean(ja[key]), en: Boolean(en[key]) }).toEqual({ layer, ja: true, en: true });
    }
  });

  test("a reason reads as its sentence with the provider and resource type it names", () => {
    setLocale("en");
    const line = policyReasonLine({
      code: "provider_not_allowed",
      layer: "provider",
      provider: "registry.opentofu.org/cloudflare/cloudflare",
    });
    expect(line.text).toBe(t("policy.reason.provider_not_allowed"));
    expect(line.provider).toBe("Cloudflare");
    expect(line.resourceType).toBeUndefined();
    expect(line.fallback).toBe(false);
    expect(
      policyReasonLine({ code: "resource_type_not_allowed", layer: "resource", resourceType: "aws_s3_bucket" })
        .resourceType,
    ).toBe("aws_s3_bucket");
  });

  test("a code this build does not know falls back to its layer, then to a generic line", () => {
    setLocale("en");
    const unknownCode = { code: "future_code", layer: "quota" } as unknown as RunPolicyReason;
    expect(policyReasonLine(unknownCode)).toEqual({
      text: t("policy.reason.unknownInLayer", { layer: t("policy.layer.quota") }),
      fallback: true,
    });
    const unknownBoth = { code: "future_code", layer: "future_layer" } as unknown as RunPolicyReason;
    expect(policyReasonLine(unknownBoth).text).toBe(t("policy.reason.unknown"));
  });

  test("approval reasons are told apart from blocks", () => {
    expect(isApprovalReason({ code: "approval_required_change", layer: "action" })).toBe(true);
    expect(isApprovalReason({ code: "approval_required_destroy", layer: "action" })).toBe(true);
    expect(isApprovalReason({ code: "provider_denied", layer: "provider" })).toBe(false);
  });

  test("the dashboard never reads the Run's prose policy reasons", () => {
    const sources = [
      "lib/policy-reasons.ts",
      "components/run/PolicyReasonList.tsx",
      "views/app/RunPolicyReasons.tsx",
      "views/app/AppHistorySection.tsx",
      "views/app/AppAttentionSection.tsx",
    ].map((file) => readFileSync(resolve(root, file), "utf8"));
    for (const source of sources) {
      // Only the structured `policyReasons` field: no decision prose, and no
      // pattern matching on reason text.
      expect(source).not.toMatch(/policyDecision|policy\.reasons\b|\.exec\(|\.match\(/u);
    }
    const run = readFileSync(resolve(root, "views/runs/RunView.tsx"), "utf8");
    expect(run).toContain("<PolicyReasonList reasons={r().policyReasons ?? []} />");
  });
});
