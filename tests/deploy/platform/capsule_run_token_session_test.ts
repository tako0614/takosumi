import { expect, test } from "bun:test";
import { verifyPlatformExtensionSession } from "../../../deploy/platform/worker.ts";
import { createCapsuleRunToken } from "../../../core/shared/capsule_run_tokens.ts";
import type { PlatformExtensionRoute } from "../../../deploy/platform/platform_extensions.ts";

const SECRET = "run-token-secret";

function envWith(): Record<string, unknown> {
  return { TAKOSUMI_RUN_TOKEN_SECRET: SECRET };
}

async function tokenRequest(): Promise<Request> {
  const { token } = await createCapsuleRunToken({
    secret: SECRET,
    workspaceId: "ws_1",
    capsuleId: "cap_1",
    runId: "run_1",
    mutable: true,
  });
  return new Request("https://app.takosumi.test/v1/interfaces", {
    headers: { authorization: `Bearer ${token}` },
  });
}

test("capsule run token authenticates on the routeless control-plane path", async () => {
  const session = await verifyPlatformExtensionSession(
    await tokenRequest(),
    envWith() as never,
  );
  expect(session.authenticated).toBe(true);
  expect(session.authKind).toBe("capsule-run-token");
  expect(session.workspaceId).toBe("ws_1");
  expect(session.capsuleId).toBe("cap_1");
});

test("capsule run token is rejected on a platform extension route", async () => {
  const route: PlatformExtensionRoute = {
    basePath: "/gateway/ai/v1",
    handlerKey: "AI_GATEWAY",
    managedProviderProfile: "operator.ai.gateway.v1",
    requiredScopes: ["ai.invoke"],
    capabilities: ["ai.v1"],
    contributions: [],
  };
  const session = await verifyPlatformExtensionSession(
    await tokenRequest(),
    envWith() as never,
    route,
  );
  expect(session.authenticated).toBe(false);
});
