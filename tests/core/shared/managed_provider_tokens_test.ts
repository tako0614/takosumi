import { describe, expect, test } from "bun:test";
import {
  createManagedProviderRunToken,
  managedProviderRunTokenSecret,
  verifyManagedProviderRunToken,
} from "../../../core/shared/managed_provider_tokens.ts";

const NOW = 1_800_000_000_000;

describe("managed provider run token", () => {
  test("binds arbitrary ids and every authority claim with a full HMAC", async () => {
    const issued = await createManagedProviderRunToken({
      secret: "issuer-secret",
      audience: "operator.example.provider.v1",
      subject: "run:run_01J-CUSTOM",
      workspaceId: "workspace/customer-a",
      capsuleId: "capsule:git.example/app@sha256:1234",
      connectionId: "provider-connection/custom-01",
      provider: "registry.example/custom/provider",
      phase: "apply",
      scopes: ["resources.write", "usage.emit"],
      ttlSeconds: 600,
      now: () => NOW,
      jti: "run_01J-CUSTOM:apply:1",
    });

    const segments = issued.token.split(".");
    expect(segments).toHaveLength(3);
    expect(segments[2]).toHaveLength(43);
    const verified = await verifyManagedProviderRunToken(issued.token, {
      secret: "issuer-secret",
      expectedAudience: "operator.example.provider.v1",
      expectedWorkspaceId: "workspace/customer-a",
      expectedCapsuleId: "capsule:git.example/app@sha256:1234",
      expectedConnectionId: "provider-connection/custom-01",
      expectedProvider: "registry.example/custom/provider",
      expectedPhase: "apply",
      expectedSubject: "run:run_01J-CUSTOM",
      requiredScopes: ["resources.write"],
      now: () => NOW + 1_000,
    });

    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error(verified.reason);
    expect(verified.payload).toMatchObject({
      workspaceId: "workspace/customer-a",
      capsuleId: "capsule:git.example/app@sha256:1234",
      connectionId: "provider-connection/custom-01",
      provider: "registry.example/custom/provider",
      phase: "apply",
      iat: NOW / 1000,
      exp: NOW / 1000 + 600,
      jti: "run_01J-CUSTOM:apply:1",
    });
    expect(
      await verifyManagedProviderRunToken(issued.token, {
        secret: "issuer-secret",
        expectedAudience: "operator.example.provider.v1/",
        now: () => NOW + 1_000,
      }),
    ).toEqual({ ok: false, reason: "audience_mismatch" });
  });

  test("rejects confused-deputy reuse and signature tampering", async () => {
    const issued = await createManagedProviderRunToken({
      secret: "issuer-secret",
      audience: "operator.provider-a.v1",
      workspaceId: "workspace-a",
      connectionId: "connection-a",
      provider: "example/provider",
      phase: "plan",
      scopes: ["read"],
      now: () => NOW,
      jti: "jti-a",
    });

    expect(
      await verifyManagedProviderRunToken(issued.token, {
        secret: "issuer-secret",
        expectedAudience: "operator.provider-b.v1",
        now: () => NOW,
      }),
    ).toEqual({ ok: false, reason: "audience_mismatch" });

    const final = issued.token.at(-1);
    const tampered = `${issued.token.slice(0, -1)}${final === "A" ? "B" : "A"}`;
    expect(
      await verifyManagedProviderRunToken(tampered, {
        secret: "issuer-secret",
        expectedAudience: "operator.provider-a.v1",
        now: () => NOW,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  test("never reuses the deploy-control authority as its signing secret", () => {
    expect(
      managedProviderRunTokenSecret({
        TAKOSUMI_DEPLOY_CONTROL_TOKEN: "deploy-control-secret",
      }),
    ).toBeUndefined();
    expect(
      managedProviderRunTokenSecret({
        TAKOSUMI_MANAGED_PROVIDER_TOKEN_SECRET: "provider-secret",
        TAKOSUMI_DEPLOY_CONTROL_TOKEN: "deploy-control-secret",
      }),
    ).toBe("provider-secret");
  });
});
