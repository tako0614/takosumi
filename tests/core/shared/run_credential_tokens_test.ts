import { describe, expect, test } from "bun:test";
import {
  createRunCredentialToken,
  isRunCredentialToken,
  runCredentialTokenSecret,
  verifyRunCredentialToken,
} from "../../../core/shared/run_credential_tokens.ts";

const NOW = 1_800_000_000_000;
const FULL_CLAIMS = {
  audience: "operator.example.provider.v1",
  subject: "untrusted-token-subject",
  workspaceId: "workspace/customer-a",
  capsuleId: "capsule:git.example/app@sha256:1234",
  runId: "run_01J-CUSTOM",
  installingPrincipalId: "principal:installer/42",
  connectionId: "connection:operator/provider",
  provider: "registry.example/custom/provider",
  phase: "apply" as const,
  scopes: ["read", "write"],
};

describe("run credential token", () => {
  test("mints only the generic format and binds every authority claim", async () => {
    const issued = await createRunCredentialToken({
      secret: "issuer-secret",
      ...FULL_CLAIMS,
      ttlSeconds: 600,
      now: () => NOW,
      jti: "run_01J-CUSTOM:apply:1",
    });

    expect(issued.token.startsWith("takrct_v1.")).toBe(true);
    expect(isRunCredentialToken(issued.token)).toBe(true);
    const verified = await verifyRunCredentialToken(issued.token, {
      secret: "issuer-secret",
      expectedAudience: FULL_CLAIMS.audience,
      expectedWorkspaceId: FULL_CLAIMS.workspaceId,
      expectedCapsuleId: FULL_CLAIMS.capsuleId,
      expectedRunId: FULL_CLAIMS.runId,
      expectedInstallingPrincipalId: FULL_CLAIMS.installingPrincipalId,
      expectedConnectionId: FULL_CLAIMS.connectionId,
      expectedProvider: FULL_CLAIMS.provider,
      expectedPhase: "apply",
      requiredScopes: ["write"],
      now: () => NOW + 1_000,
    });

    expect(verified).toEqual({
      ok: true,
      payload: {
        v: 1,
        typ: "takosumi-run-credential",
        aud: FULL_CLAIMS.audience,
        sub: FULL_CLAIMS.subject,
        workspaceId: FULL_CLAIMS.workspaceId,
        capsuleId: FULL_CLAIMS.capsuleId,
        runId: FULL_CLAIMS.runId,
        installingPrincipalId: FULL_CLAIMS.installingPrincipalId,
        connectionId: FULL_CLAIMS.connectionId,
        provider: FULL_CLAIMS.provider,
        phase: "apply",
        scopes: ["read", "write"],
        iat: NOW / 1000,
        exp: NOW / 1000 + 600,
        jti: "run_01J-CUSTOM:apply:1",
      },
    });
  });

  test("rejects audience, scope, phase, and signature confusion", async () => {
    const issued = await createRunCredentialToken({
      secret: "issuer-secret",
      ...FULL_CLAIMS,
      now: () => NOW,
      jti: "jti-a",
    });
    for (const [input, reason] of [
      [{ expectedAudience: "other" }, "audience_mismatch"],
      [
        { expectedAudience: FULL_CLAIMS.audience, requiredScopes: ["admin"] },
        "scope_mismatch",
      ],
      [
        { expectedAudience: FULL_CLAIMS.audience, expectedPhase: "destroy" },
        "phase_mismatch",
      ],
    ] as const) {
      expect(
        await verifyRunCredentialToken(issued.token, {
          secret: "issuer-secret",
          now: () => NOW,
          ...input,
        }),
      ).toEqual({ ok: false, reason });
    }

    const final = issued.token.at(-1);
    const tampered = `${issued.token.slice(0, -1)}${final === "A" ? "B" : "A"}`;
    expect(
      await verifyRunCredentialToken(tampered, {
        secret: "issuer-secret",
        expectedAudience: FULL_CLAIMS.audience,
        now: () => NOW,
      }),
    ).toEqual({ ok: false, reason: "invalid_signature" });
  });

  test("accepts only the generic token prefix and dedicated secret", async () => {
    expect(
      runCredentialTokenSecret({
        TAKOSUMI_DEPLOY_CONTROL_TOKEN: "deploy-control-secret",
      }),
    ).toBeUndefined();
    expect(
      runCredentialTokenSecret({ TAKOSUMI_RUN_CREDENTIAL_TOKEN_SECRET: "run-secret" }),
    ).toBe("run-secret");
    expect(runCredentialTokenSecret({})).toBeUndefined();
    const unrelated = "other_v1.payload.signature";
    expect(isRunCredentialToken(unrelated)).toBe(false);
    expect(
      await verifyRunCredentialToken(unrelated, {
        secret: "issuer-secret",
        expectedAudience: FULL_CLAIMS.audience,
        now: () => NOW,
      }),
    ).toEqual({ ok: false, reason: "not_run_credential_token" });
  });

  test("bounds the token envelope and every caller-selected claim", async () => {
    const oversized = `takrct_v1.${"A".repeat(33_000)}.signature`;
    expect(isRunCredentialToken(oversized)).toBe(false);
    expect(
      await verifyRunCredentialToken(oversized, {
        secret: "issuer-secret",
        expectedAudience: FULL_CLAIMS.audience,
        now: () => NOW,
      }),
    ).toEqual({ ok: false, reason: "malformed_run_credential_token" });
    expect(isRunCredentialToken("takrct_v1.payload.signature\n")).toBe(false);

    await expect(
      createRunCredentialToken({
        secret: "issuer-secret",
        ...FULL_CLAIMS,
        audience: "extension.example.v1\n",
      }),
    ).rejects.toThrow(/exact bounded/);
    await expect(
      createRunCredentialToken({
        secret: "issuer-secret",
        ...FULL_CLAIMS,
        scopes: Array.from({ length: 65 }, (_, index) => `scope:${index}`),
      }),
    ).rejects.toThrow(/1-64 exact bounded/);
  });

  test("rejects non-canonical payload shape, duplicate scopes, and short lifetimes", async () => {
    const payload = {
      v: 1,
      typ: "takosumi-run-credential",
      aud: FULL_CLAIMS.audience,
      sub: FULL_CLAIMS.subject,
      workspaceId: FULL_CLAIMS.workspaceId,
      capsuleId: FULL_CLAIMS.capsuleId,
      runId: FULL_CLAIMS.runId,
      installingPrincipalId: FULL_CLAIMS.installingPrincipalId,
      connectionId: FULL_CLAIMS.connectionId,
      provider: FULL_CLAIMS.provider,
      phase: FULL_CLAIMS.phase,
      scopes: FULL_CLAIMS.scopes,
      iat: NOW / 1000,
      exp: NOW / 1000 + 600,
      jti: "canonical-payload",
    };
    for (const invalid of [
      { ...payload, extraAuthority: "forbidden" },
      { ...payload, scopes: ["read", "read"] },
    ]) {
      expect(
        await verifyRunCredentialToken(
          await signedGenericToken(invalid, "issuer-secret"),
          {
            secret: "issuer-secret",
            expectedAudience: FULL_CLAIMS.audience,
            now: () => NOW,
          },
        ),
      ).toEqual({ ok: false, reason: "invalid_payload" });
    }
    expect(
      await verifyRunCredentialToken(
        await signedGenericToken(
          { ...payload, exp: payload.iat + 59 },
          "issuer-secret",
        ),
        {
          secret: "issuer-secret",
          expectedAudience: FULL_CLAIMS.audience,
          now: () => NOW,
        },
      ),
    ).toEqual({ ok: false, reason: "invalid_lifetime" });
  });
});

async function signedGenericToken(
  payload: object,
  secret: string,
): Promise<string> {
  const encoded = base64Url(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signed = `v1.${encoded}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signed)),
  );
  return `takrct_${signed}.${base64Url(signature)}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/u, "");
}
