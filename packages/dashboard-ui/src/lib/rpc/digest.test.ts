import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Canonical, sha256HexText } from "./digest";

describe("canonicalJson", () => {
  it("sorts object keys (matches the server's canonicalJson)", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("serializes nested objects and arrays deterministically", () => {
    expect(canonicalJson({ z: [3, { y: 1, x: 2 }], a: "v" })).toBe(
      '{"a":"v","z":[3,{"x":2,"y":1}]}',
    );
  });

  it("renders nullish as null and empty objects as {}", () => {
    expect(canonicalJson(undefined)).toBe("null");
    expect(canonicalJson({})).toBe("{}");
  });

  it("produces the exact canonical form for a materialize payload", () => {
    // This string must match what the server hashes
    // (accounts-service appInstallationMaterializeDigest); the digest is
    // byte-compared on the materialize endpoint, so any drift breaks confirm.
    expect(
      canonicalJson({
        operation: "materialize",
        installationId: "ins_abc123",
        mode: "dedicated",
        region: "default",
        plan: {},
        cutover: {},
      }),
    ).toBe(
      '{"cutover":{},"installationId":"ins_abc123","mode":"dedicated","operation":"materialize","plan":{},"region":"default"}',
    );
  });
});

describe("sha256HexText / sha256Canonical", () => {
  it("returns a sha256:<64-hex> digest the server's isSha256HexDigest accepts", async () => {
    const digest = await sha256Canonical({ operation: "materialize" });
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("matches a known SHA-256 (empty string)", async () => {
    expect(await sha256HexText("")).toBe(
      "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  it("is deterministic for equal canonical input regardless of key order", async () => {
    const a = await sha256Canonical({ region: "default", mode: "dedicated" });
    const b = await sha256Canonical({ mode: "dedicated", region: "default" });
    expect(a).toBe(b);
  });
});
