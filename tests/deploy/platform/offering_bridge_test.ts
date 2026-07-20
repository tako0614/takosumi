import { expect, test } from "bun:test";

import type {
  OfferingAvailability,
  OfferingSelection,
} from "../../../contract/index.ts";
import { formHostResourceNamespaceOfferingContext } from "../../../contract/index.ts";
import {
  listPlatformOfferingAvailability,
  resolvePlatformOffering,
} from "../../../deploy/platform/worker.ts";

const reference = {
  catalogId: "operator-default",
  catalogVersion: "v1",
  offeringId: "ai-gateway",
  offeringVersion: "v1",
} as const;
const subject = {
  type: "services.example.test/v1/Endpoint",
  ref: "ai-gateway",
  version: "2026-07-20",
  digest: `sha256:${"a".repeat(64)}`,
} as const;

test("platform bridges use the OSS Offering operations with exact principal context", async () => {
  const calls: unknown[] = [];
  const availability: readonly OfferingAvailability[] = [
    {
      reference,
      subject,
      profile: "openai-compatible",
      region: "global",
      maturity: "stable",
      availableToPrincipal: true,
    },
  ];
  const selection: OfferingSelection = {
    reference,
    subject,
    requirements: [],
    profile: "openai-compatible",
    region: "global",
    maturity: "stable",
    resolverId: "ai-gateway-resolver",
    resolutionFingerprint: `sha256:${"b".repeat(64)}`,
    resolvedAt: "2026-07-20T00:00:00.000Z",
  };
  const operations = async () => ({
    offerings: {
      listAvailability: async (input: unknown) => {
        calls.push(input);
        return availability;
      },
      resolve: async (input: unknown) => {
        calls.push(input);
        return selection;
      },
    },
  });

  expect(
    await listPlatformOfferingAvailability(
      {
        catalogId: reference.catalogId,
        catalogVersion: reference.catalogVersion,
        principalId: "account_1",
        roles: ["developer"],
        workspaceId: "workspace_1",
        contexts: [
          formHostResourceNamespaceOfferingContext("resource_scope_1"),
        ],
      },
      {},
      operations as never,
    ),
  ).toEqual(availability);
  expect(
    await resolvePlatformOffering(
      {
        reference,
        principalId: "account_1",
        roles: ["developer"],
        workspaceId: "workspace_1",
        contexts: [
          formHostResourceNamespaceOfferingContext("resource_scope_1"),
        ],
      },
      {},
      operations as never,
    ),
  ).toEqual(selection);
  expect(calls).toEqual([
    {
      catalogId: reference.catalogId,
      catalogVersion: reference.catalogVersion,
      principalId: "account_1",
      roles: ["developer"],
      workspaceId: "workspace_1",
      contexts: [formHostResourceNamespaceOfferingContext("resource_scope_1")],
    },
    {
      reference,
      principalId: "account_1",
      roles: ["developer"],
      workspaceId: "workspace_1",
      contexts: [formHostResourceNamespaceOfferingContext("resource_scope_1")],
    },
  ]);
});
