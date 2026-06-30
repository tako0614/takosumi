import { describe, expect, test } from "bun:test";
import {
  activeCloudApiTokens,
  aiGatewayRoute,
  cloudflareCompatRoute,
  s3CompatibleRoute,
  type CloudExtensionCatalog,
} from "../../../../dashboard/src/lib/cloud-resources.ts";
import type { TakosumiAccountsPatMetadata } from "@takosjp/takosumi-accounts-contract";

describe("dashboard cloud resources route selection", () => {
  test("activeCloudApiTokens hides revoked and expired keys", () => {
    const now = Date.parse("2026-06-30T00:00:00.000Z");
    const token = (
      id: string,
      extra: Partial<TakosumiAccountsPatMetadata> = {},
    ): TakosumiAccountsPatMetadata => ({
      id,
      subject: "tsub_test",
      name: id,
      prefix: `takpat_${id}`,
      scopes: ["read"],
      created_at: "2026-06-29T00:00:00.000Z",
      ...extra,
    });

    expect(
      activeCloudApiTokens(
        [
          token("active"),
          token("future", { expires_at: "2026-07-01T00:00:00.000Z" }),
          token("revoked", { revoked_at: "2026-06-29T12:00:00.000Z" }),
          token("expired", { expires_at: "2026-06-29T00:00:00.000Z" }),
          token("invalid", { expires_at: "not-a-date" }),
        ],
        now,
      ).map((item) => item.id),
    ).toEqual(["active", "future"]);
  });

  test("recognizes the generic platform extension catalog used by production", () => {
    const catalog: CloudExtensionCatalog = {
      kind: "takosumi.platform-cloud-extensions@v1",
      generatedAt: "2026-06-28T00:00:00.000Z",
      serviceUrl: "https://app.takosumi.com",
      extensions: [
        {
          basePath: "/gateway/ai/v1",
          configured: true,
          requiredScopes: ["ai.models.read", "ai.chat", "ai.embeddings"],
        },
        {
          basePath: "/compat/cloudflare/client/v4",
          configured: true,
        },
        {
          basePath: "/compat/s3/v1",
          protocol: "s3-compatible",
          configured: true,
          capabilities: ["compat.s3.v1"],
          authMode: "handler",
        },
      ],
      summary: { total: 3, configured: 3, missing: 0 },
    };

    expect(aiGatewayRoute(catalog)?.basePath).toBe("/gateway/ai/v1");
    expect(cloudflareCompatRoute(catalog)?.basePath).toBe(
      "/compat/cloudflare/client/v4",
    );
    expect(s3CompatibleRoute(catalog)?.basePath).toBe("/compat/s3/v1");
  });

  test("still accepts richer Cloud-only descriptors when the closed delta provides them", () => {
    const catalog: CloudExtensionCatalog = {
      kind: "takosumi.platform-cloud-extensions@v1",
      generatedAt: "2026-06-28T00:00:00.000Z",
      serviceUrl: "https://app.takosumi.com",
      extensions: [
        {
          id: "ai",
          kind: "ai_gateway",
          protocol: "openai-compatible",
          basePath: "/custom/ai",
          configured: true,
        },
        {
          id: "cloudflare",
          kind: "provider_compat",
          provider: "cloudflare",
          protocol: "cloudflare-v4",
          basePath: "/custom/cloudflare",
          configured: true,
        },
      ],
      summary: { total: 2, configured: 2, missing: 0 },
    };

    expect(aiGatewayRoute(catalog)?.basePath).toBe("/custom/ai");
    expect(cloudflareCompatRoute(catalog)?.basePath).toBe("/custom/cloudflare");
  });
});
