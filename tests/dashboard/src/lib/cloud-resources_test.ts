import { describe, expect, test } from "bun:test";
import {
  aiGatewayRoute,
  cloudflareCompatRoute,
  type CloudExtensionCatalog,
} from "../../../../dashboard/src/lib/cloud-resources.ts";

describe("dashboard cloud resources route selection", () => {
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
      ],
      summary: { total: 2, configured: 2, missing: 0 },
    };

    expect(aiGatewayRoute(catalog)?.basePath).toBe("/gateway/ai/v1");
    expect(cloudflareCompatRoute(catalog)?.basePath).toBe(
      "/compat/cloudflare/client/v4",
    );
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
    expect(cloudflareCompatRoute(catalog)?.basePath).toBe(
      "/custom/cloudflare",
    );
  });
});
