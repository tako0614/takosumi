import assert from "node:assert/strict";
import { resolveMode } from "../src/config.ts";

Deno.test("resolveMode prefers explicit --remote flag", () => {
  const result = resolveMode(
    { remote: "https://kernel.local", token: "t1" },
    { kernelUrl: "https://config.local", token: "tcfg" },
  );
  assert.deepEqual(result, {
    mode: "remote",
    url: "https://kernel.local",
    token: "t1",
  });
});

Deno.test("resolveMode falls back to config kernelUrl", () => {
  const result = resolveMode(
    {},
    { kernelUrl: "https://config.local", token: "tcfg" },
  );
  assert.deepEqual(result, {
    mode: "remote",
    url: "https://config.local",
    token: "tcfg",
  });
});

Deno.test("resolveMode returns local when no URL configured", () => {
  const result = resolveMode({}, {});
  assert.deepEqual(result, { mode: "local" });
});
