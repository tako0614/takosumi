import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUuid } from "../../../../dashboard/src/lib/random-uuid.ts";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const original = globalThis.crypto.randomUUID;

afterEach(() => {
  Object.defineProperty(globalThis.crypto, "randomUUID", {
    value: original,
    configurable: true,
    writable: true,
  });
});

describe("randomUuid", () => {
  test("uses the platform UUID when available", () => {
    expect(randomUuid()).toMatch(V4);
  });

  test("still mints v4 UUIDs outside a secure context", () => {
    // Plain-HTTP self-host: browsers omit crypto.randomUUID there.
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
      writable: true,
    });
    const ids = new Set(Array.from({ length: 64 }, () => randomUuid()));
    expect(ids.size).toBe(64);
    for (const id of ids) expect(id).toMatch(V4);
  });

  test("dashboard code mints ids only through the helper", () => {
    const root = resolve(import.meta.dir, "../../../../dashboard/src");
    const sources = [
      ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: root, absolute: true }),
    ].filter((file) => !file.endsWith("/lib/random-uuid.ts"));
    const offenders = sources.filter((file) =>
      readFileSync(file, "utf8").includes("crypto.randomUUID()"),
    );
    expect(offenders).toEqual([]);
  });
});
