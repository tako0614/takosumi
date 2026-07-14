import { expect, test } from "bun:test";
import {
  isPlatformHardeningContribution,
  platformHardeningEvidenceDocumentErrors,
} from "../../contract/platform-hardening.ts";

const contribution = {
  kind: "takosumi.platform-hardening-contribution@v1",
  id: "operator-runtime",
  capability: "operator.runtime-hardening.v1",
  checks: [
    {
      id: "runtime-proof",
      title: "Runtime proof",
      description: "Attests an operator-selected runtime without naming it.",
      evidenceSchema: {
        required: ["runtimeId", "status", "probes"],
        properties: {
          runtimeId: { type: "string" },
          status: { type: "string", const: "passed" },
          probes: {
            type: "string-array",
            contains: ["start", "execute", "cleanup"],
          },
        },
      },
    },
  ],
} as const;

test("hardening contributions are data-only and open to operator check ids", () => {
  expect(isPlatformHardeningContribution(contribution)).toBe(true);
  expect(
    isPlatformHardeningContribution({
      ...contribution,
      checks: [contribution.checks[0], contribution.checks[0]],
    }),
  ).toBe(false);
  expect(
    isPlatformHardeningContribution({
      ...contribution,
      checks: [
        {
          ...contribution.checks[0],
          evidenceSchema: {
            properties: {
              invalid: { type: "boolean", const: "yes" },
            },
          },
        },
      ],
    }),
  ).toBe(false);
});

test("hardening evidence is validated through the contributed schema", () => {
  const schema = contribution.checks[0].evidenceSchema;
  expect(
    platformHardeningEvidenceDocumentErrors(
      {
        runtimeId: "custom-executor",
        status: "passed",
        probes: ["start", "execute", "cleanup", "operator-extra"],
      },
      schema,
    ),
  ).toEqual([]);
  expect(
    platformHardeningEvidenceDocumentErrors(
      {
        runtimeId: "custom-executor",
        status: "failed",
        probes: ["start"],
      },
      schema,
    ),
  ).toEqual([
    "evidence document.status must be passed",
    "evidence document.probes is missing execute",
    "evidence document.probes is missing cleanup",
  ]);
});
