import { describe, expect, test } from "bun:test";
import {
  authenticateHostedMeteredRequest, createHostedMeteredRequestHeaders,
  hostedMeteredContext, hostedMeteredSha256, importHostedMeteredKey,
  parseHostedMeteredLocalAdmission, readHostedMeteredFrames,
} from "../../runner/lib/hosted_metered_protocol.ts";

const body = new TextEncoder().encode('{"action":"plan","runId":"run-proof"}');
const admission = {
  kind: "takosumi.hosted-metered-local-admission@v1", profile: "hosted-metered-v1",
  authority: "local-native-proof", workspaceId: "workspace-proof", runId: "run-proof",
  attemptId: "attempt-proof", imageDigest: "sha256:" + "a".repeat(64),
  admissionNonce: "admission-nonce-000001", requestBodySha256: await hostedMeteredSha256(body),
};
const context = hostedMeteredContext(parseHostedMeteredLocalAdmission(admission), "boot-nonce-000000001");
const key = await importHostedMeteredKey(new Uint8Array(32).fill(91));
const url = "http://collector.invalid/runs/run-proof?sequence=1";
const nonce = "request-nonce-0000001";

describe("Hosted-metered raw CPU qualification boundary", () => {
  test("does not reinterpret platform/policy strings as local kernel qualification", () => {
    for (const value of [
      { ...admission, authority: "cloudflare" },
      { ...admission, kind: "takosumi.hosted-metered-cloudflare-admission@v1" },
      { ...admission, schedulingPolicy: "default" },
      { ...admission, runId: "run/other" },
      { ...admission, imageDigest: "latest" },
    ]) expect(() => parseHostedMeteredLocalAdmission(value)).toThrow();
  });

  test("authenticates exact method, query, body, boot, and original Run context", async () => {
    const headers = await createHostedMeteredRequestHeaders(key, context, nonce, "POST", url, body);
    expect(await authenticateHostedMeteredRequest(key, context, new Request(url, { method: "POST", headers }), body)).toBe(nonce);
    for (const [method, target, bytes] of [
      ["PUT", url, body],
      ["POST", url.replace("sequence=1", "sequence=2"), body],
      ["POST", url.replace("run-proof", "run-other"), body],
      ["POST", url, new TextEncoder().encode('{"action":"apply"}')],
    ] as const) {
      expect(await authenticateHostedMeteredRequest(key, context,
        new Request(target, { method, headers }), bytes)).toBeNull();
    }
    for (const expected of [
      { ...context, bootId: "other-boot-000000001" },
      { ...context, runId: "run-other" },
      { ...context, workspaceId: "workspace-other" },
      { ...context, requestBodySha256: "b".repeat(64) },
    ]) expect(await authenticateHostedMeteredRequest(key, expected,
      new Request(url, { method: "POST", headers }), body)).toBeNull();
  });

  test("rejects forged MAC, unknown context fields, alternate encoding, and nonce substitution", async () => {
    const original = await createHostedMeteredRequestHeaders(key, context, nonce, "POST", url, body);
    for (const headers of [
      { ...original, "x-takosumi-metered-signature": "0".repeat(64) },
      { ...original, "x-takosumi-metered-nonce": "request-nonce-0000002" },
      { ...original, "x-takosumi-metered-context": original["x-takosumi-metered-context"] + "=" },
      { ...original, "x-takosumi-metered-context": Buffer.from(JSON.stringify({ ...context, trusted: true })).toString("base64url") },
    ]) expect(await authenticateHostedMeteredRequest(key, context,
      new Request(url, { method: "POST", headers }), body)).toBeNull();
  });

  test("IPC rejects partial/empty/malformed streams rather than accepting a partial response", async () => {
    for (const text of ['{"kind":"response"}', "\n", "not-json\n"]) {
      const received: unknown[] = [];
      const read = async () => {
        for await (const value of readHostedMeteredFrames(new Response(text).body!)) received.push(value);
      };
      await expect(read()).rejects.toThrow();
      expect(received).toEqual([]);
    }
  });
});
